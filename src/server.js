const express = require('express');
const path = require('path');
const { createClient } = require('redis');

const app = express();
const port = Number(process.env.PORT || 3000);

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = Number(process.env.REDIS_PORT || 6379);
const redisUsername = process.env.REDIS_USERNAME || '';
const redisPassword = process.env.REDIS_PASSWORD || '';
const cacheTtl = Number(process.env.CACHE_TTL_SECONDS || 45);
const sessionTtl = Number(process.env.SESSION_TTL_SECONDS || 900);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 5);
const rateLimitWindow = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60);

const accounts = new Map([
  ['1001300001', { accountNo: '1001300001', customerId: 'C-992301', name: 'Budi Santoso', type: 'Checking', balance: 18750000 }],
  ['1001300002', { accountNo: '1001300002', customerId: 'C-992301', name: 'Budi Santoso', type: 'Savings', balance: 5250000 }],
  ['1002400001', { accountNo: '1002400001', customerId: 'C-884120', name: 'Dewi Rahayu', type: 'Checking', balance: 32100000 }]
]);

const redis = createClient({
  socket: {
    host: redisHost,
    port: redisPort
  },
  username: redisUsername || undefined,
  password: redisPassword || undefined
});

redis.on('error', (error) => {
  console.error('Redis error:', error.message);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicAccount(account) {
  return {
    accountNo: account.accountNo,
    customerId: account.customerId,
    name: account.name,
    type: account.type,
    balance: account.balance
  };
}

async function enforceRateLimit(customerId) {
  const key = `ratelimit:balance:${customerId}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, rateLimitWindow);
  }

  if (count > rateLimitMax) {
    const ttl = await redis.ttl(key);
    const error = new Error('Too many balance inquiries. Wait before trying again.');
    error.status = 429;
    error.retryAfter = ttl;
    throw error;
  }

  return { key, count, remaining: Math.max(rateLimitMax - count, 0) };
}

app.get('/health', async (req, res) => {
  const pong = await redis.ping();
  res.json({
    status: 'ok',
    redis: pong,
    app: 'finance-redis-demo'
  });
});

app.get('/api/accounts', (req, res) => {
  res.json(Array.from(accounts.values()).map(publicAccount));
});

app.post('/api/session', async (req, res) => {
  const customerId = req.body.customerId || 'C-992301';
  const key = `session:finance:${customerId}`;
  const loginTime = new Date().toISOString();

  await redis.hSet(key, {
    customerId,
    channel: 'web',
    status: 'active',
    loginTime
  });
  await redis.expire(key, sessionTtl);

  res.json({
    message: 'session created',
    redisKey: key,
    ttlSeconds: sessionTtl
  });
});

app.get('/api/balance/:accountNo', async (req, res, next) => {
  try {
    const account = accounts.get(req.params.accountNo);
    if (!account) {
      return res.status(404).json({ error: 'account not found' });
    }

    const rateLimit = await enforceRateLimit(account.customerId);
    const cacheKey = `cache:balance:${account.accountNo}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({
        source: 'redis-cache',
        redisKey: cacheKey,
        rateLimit,
        data: JSON.parse(cached)
      });
    }

    await sleep(180);

    const data = {
      accountNo: account.accountNo,
      customerId: account.customerId,
      type: account.type,
      balance: account.balance,
      currency: 'IDR',
      fetchedAt: new Date().toISOString()
    };

    await redis.set(cacheKey, JSON.stringify(data), { EX: cacheTtl });

    res.json({
      source: 'core-banking',
      redisKey: cacheKey,
      ttlSeconds: cacheTtl,
      rateLimit,
      data
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/transfer', async (req, res) => {
  const from = req.body.from || '1001300001';
  const to = req.body.to || '1001300002';
  const amount = Number(req.body.amount || 25000);

  const source = accounts.get(from);
  const destination = accounts.get(to);

  if (!source || !destination) {
    return res.status(404).json({ error: 'source or destination account not found' });
  }

  if (amount <= 0 || source.balance < amount) {
    return res.status(400).json({ error: 'invalid transfer amount' });
  }

  const lockKey = `lock:transfer:${from}`;
  const lockAcquired = await redis.set(lockKey, 'finance-api', { NX: true, EX: 15 });

  if (!lockAcquired) {
    return res.status(409).json({
      error: 'transfer already in progress',
      redisKey: lockKey
    });
  }

  try {
    await sleep(120);
    source.balance -= amount;
    destination.balance += amount;

    const transactionId = `TRX-${Date.now()}`;
    const transactionKey = `txn:finance:${transactionId}`;

    await redis.del([`cache:balance:${from}`, `cache:balance:${to}`]);
    await redis.hSet(transactionKey, {
      transactionId,
      from,
      to,
      amount: String(amount),
      status: 'posted',
      postedAt: new Date().toISOString()
    });
    await redis.expire(transactionKey, 600);

    res.json({
      message: 'transfer posted',
      transactionId,
      transactionKey,
      invalidatedKeys: [`cache:balance:${from}`, `cache:balance:${to}`],
      balances: {
        [from]: source.balance,
        [to]: destination.balance
      }
    });
  } finally {
    await redis.del(lockKey);
  }
});

app.get('/api/redis/keys', async (req, res) => {
  const keys = [];
  for await (const key of redis.scanIterator({ MATCH: '*', COUNT: 100 })) {
    const ttl = await redis.ttl(key);
    const type = await redis.type(key);
    keys.push({ key, type, ttl });
  }

  keys.sort((a, b) => a.key.localeCompare(b.key));
  res.json(keys);
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({
    error: error.message || 'internal server error',
    retryAfter: error.retryAfter
  });
});

async function start() {
  await redis.connect();
  app.listen(port, () => {
    console.log(`Finance Redis demo listening on port ${port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
