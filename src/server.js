const express = require('express');
const path = require('path');
const fs = require('fs');
const Datastore = require('nedb-promises');
const { createClient } = require('redis');

const app = express();
const port = Number(process.env.PORT || 3000);

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = Number(process.env.REDIS_PORT || 6379);
const redisUsername = process.env.REDIS_USERNAME || '';
const redisPassword = process.env.REDIS_PASSWORD || '';
const cacheTtl = Number(process.env.CACHE_TTL_SECONDS || 45);
const sessionTtl = Number(process.env.SESSION_TTL_SECONDS || 900);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 8);
const rateLimitWindow = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60);

const dataDir = path.join(__dirname, '..', 'data');
const accountsDb = Datastore.create({
  filename: path.join(dataDir, 'accounts.db'),
  autoload: true
});
const transactionsDb = Datastore.create({
  filename: path.join(dataDir, 'transactions.db'),
  autoload: true
});

const defaultCustomerId = 'C-992301';

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

function formatCurrency(amount) {
  return new Intl.NumberFormat('id-ID').format(amount);
}

function formatRelativeDate(isoDate) {
  const value = new Date(isoDate);
  const now = new Date();
  const diffMs = now - value;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) {
    return 'Just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }
  if (diffDays === 1) {
    return 'Yesterday';
  }

  return value.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}

function publicAccount(account) {
  return {
    accountNo: account.accountNo,
    customerId: account.customerId,
    name: account.name,
    type: account.type,
    balance: account.balance,
    updatedAt: account.updatedAt
  };
}

async function ensureSeedData() {
  fs.mkdirSync(dataDir, { recursive: true });

  const count = await accountsDb.count({});
  if (count > 0) {
    return;
  }

  const now = new Date().toISOString();

  await accountsDb.insert([
    {
      customerId: defaultCustomerId,
      name: 'Budi Santoso',
      accountNo: '1001300001',
      type: 'Checking',
      balance: 18750000,
      updatedAt: now
    },
    {
      customerId: defaultCustomerId,
      name: 'Budi Santoso',
      accountNo: '1001300002',
      type: 'Savings',
      balance: 5250000,
      updatedAt: now
    }
  ]);

  await transactionsDb.insert([
    {
      transactionId: 'TRX-992A',
      customerId: defaultCustomerId,
      fromLabel: 'Checking',
      fromAccountNo: '1001300001',
      toLabel: 'BCA - 091823912',
      toAccountNo: 'EXT-BCA-091823912',
      amount: 25000,
      status: 'Completed',
      note: 'Electricity bill',
      postedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    },
    {
      transactionId: 'TRX-881B',
      customerId: defaultCustomerId,
      fromLabel: 'Savings',
      fromAccountNo: '1001300002',
      toLabel: 'Checking',
      toAccountNo: '1001300001',
      amount: 1000000,
      status: 'Completed',
      note: 'Internal transfer',
      postedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    }
  ]);
}

async function enforceRateLimit(customerId) {
  const key = `ratelimit:balance:${customerId}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, rateLimitWindow);
  }

  if (count > rateLimitMax) {
    const ttl = await redis.ttl(key);
    const error = new Error('Too many balance inquiries. Please wait a moment.');
    error.status = 429;
    error.retryAfter = ttl;
    throw error;
  }

  return { count, remaining: Math.max(rateLimitMax - count, 0) };
}

async function getAccounts(customerId = defaultCustomerId) {
  const accounts = await accountsDb.find({ customerId }).sort({ accountNo: 1 });
  return accounts.map(publicAccount);
}

async function getTransactions(customerId = defaultCustomerId, limit = 8) {
  const rows = await transactionsDb.find({ customerId }).sort({ postedAt: -1 }).limit(limit);
  return rows.map((row) => ({
    transactionId: row.transactionId,
    fromLabel: row.fromLabel,
    toLabel: row.toLabel,
    amount: row.amount,
    status: row.status,
    note: row.note,
    postedAt: row.postedAt,
    displayDate: formatRelativeDate(row.postedAt)
  }));
}

async function getSession(customerId = defaultCustomerId) {
  const key = `session:finance:${customerId}`;
  const exists = await redis.exists(key);

  if (!exists) {
    return {
      active: false,
      customerId,
      ttlSeconds: 0
    };
  }

  const session = await redis.hGetAll(key);
  const ttlSeconds = await redis.ttl(key);
  return {
    active: true,
    customerId,
    loginTime: session.loginTime,
    ttlSeconds
  };
}

async function buildDashboard(customerId = defaultCustomerId) {
  const accounts = await getAccounts(customerId);
  const transactions = await getTransactions(customerId);
  const session = await getSession(customerId);

  const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0);
  const spending = transactions
    .filter((item) => !String(item.toLabel).startsWith('Salary'))
    .reduce((sum, item) => sum + item.amount, 0);

  return {
    profile: {
      customerId,
      name: accounts[0]?.name || 'Customer'
    },
    session,
    accounts,
    transactions,
    summary: {
      totalBalance,
      totalBalanceFormatted: formatCurrency(totalBalance),
      monthlySpendingFormatted: formatCurrency(spending),
      upcomingPayments: 2
    }
  };
}

app.get('/health', async (req, res) => {
  const pong = await redis.ping();
  res.json({
    status: 'ok',
    redis: pong,
    app: 'digital-banking-demo'
  });
});

app.get('/api/dashboard', async (req, res, next) => {
  try {
    res.json(await buildDashboard(defaultCustomerId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/accounts', async (req, res, next) => {
  try {
    res.json(await getAccounts(defaultCustomerId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/transactions', async (req, res, next) => {
  try {
    res.json(await getTransactions(defaultCustomerId));
  } catch (error) {
    next(error);
  }
});

app.post('/api/session', async (req, res, next) => {
  try {
    const customerId = req.body.customerId || defaultCustomerId;
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
      message: 'Welcome back. Your session is now active.',
      session: await getSession(customerId)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/balance/:accountNo', async (req, res, next) => {
  try {
    const account = await accountsDb.findOne({ accountNo: req.params.accountNo });
    if (!account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const rateLimit = await enforceRateLimit(account.customerId);
    const cacheKey = `cache:balance:${account.accountNo}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({
        source: 'cache',
        rateLimit,
        data: JSON.parse(cached)
      });
    }

    await sleep(150);

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
      source: 'live',
      rateLimit,
      data
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/transfer', async (req, res, next) => {
  try {
    const from = req.body.from;
    const to = req.body.to;
    const amount = Number(req.body.amount || 0);
    const note = (req.body.note || '').trim() || 'Transfer';

    const source = await accountsDb.findOne({ accountNo: from });
    if (!source) {
      return res.status(404).json({ error: 'Source account not found.' });
    }

    if (!to) {
      return res.status(400).json({ error: 'Destination account is required.' });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid transfer amount.' });
    }

    if (source.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance for this transfer.' });
    }

    const lockKey = `lock:transfer:${from}`;
    const lockAcquired = await redis.set(lockKey, 'digital-banking-demo', { NX: true, EX: 15 });

    if (!lockAcquired) {
      return res.status(409).json({ error: 'Another transfer is still being processed. Please wait.' });
    }

    try {
      const isInternal = /^\d+$/.test(to);
      const destination = isInternal ? await accountsDb.findOne({ accountNo: to }) : null;

      if (isInternal && !destination) {
        return res.status(404).json({ error: 'Destination account not found.' });
      }

      await sleep(120);

      const now = new Date().toISOString();
      const newSourceBalance = source.balance - amount;
      await accountsDb.update(
        { _id: source._id },
        { $set: { balance: newSourceBalance, updatedAt: now } }
      );

      let destinationLabel = to;
      if (destination) {
        const newDestinationBalance = destination.balance + amount;
        await accountsDb.update(
          { _id: destination._id },
          { $set: { balance: newDestinationBalance, updatedAt: now } }
        );
        destinationLabel = `${destination.type} (${destination.accountNo})`;
      }

      const transactionId = `TRX-${Date.now()}`;
      await transactionsDb.insert({
        transactionId,
        customerId: source.customerId,
        fromLabel: `${source.type} (${source.accountNo})`,
        fromAccountNo: source.accountNo,
        toLabel: destination ? destinationLabel : `External Transfer (${to})`,
        toAccountNo: to,
        amount,
        status: 'Completed',
        note,
        postedAt: now
      });

      await redis.del(`cache:balance:${source.accountNo}`);
      if (destination) {
        await redis.del(`cache:balance:${destination.accountNo}`);
      }

      res.json({
        message: 'Transfer successful.',
        transactionId,
        confirmation: {
          from: `${source.type} (${source.accountNo})`,
          to: destination ? destinationLabel : `External Transfer (${to})`,
          amount,
          amountFormatted: formatCurrency(amount),
          note,
          postedAt: now
        },
        dashboard: await buildDashboard(source.customerId)
      });
    } finally {
      await redis.del(lockKey);
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/redis/keys', async (req, res, next) => {
  try {
    const keys = [];
    for await (const key of redis.scanIterator({ MATCH: '*', COUNT: 100 })) {
      const ttl = await redis.ttl(key);
      const type = await redis.type(key);
      keys.push({ key, type, ttl });
    }
    keys.sort((a, b) => a.key.localeCompare(b.key));
    res.json(keys);
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({
    error: error.message || 'Internal server error.',
    retryAfter: error.retryAfter
  });
});

async function start() {
  await ensureSeedData();
  await connectRedisWithRetry();
  app.listen(port, () => {
    console.log(`Digital Banking Demo listening on port ${port}`);
  });
}

async function connectRedisWithRetry() {
  for (;;) {
    try {
      await redis.connect();
      console.log(`Connected to Redis at ${redisHost}:${redisPort}`);
      return;
    } catch (error) {
      console.error(`Redis is not ready yet at ${redisHost}:${redisPort}: ${error.message}`);
      await sleep(3000);
    }
  }
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
