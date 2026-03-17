/**
 * BrickPass API — Cloudflare Worker
 * City Metro Transit System
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FARE        = 1.25;
const PASS_PRICES = { day: 5.00, month: 50.00 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function genCardId() {
  const n = Math.floor(1_000_000_000 + Math.random() * 9_000_000_000);
  return `BP${n}`;
}

// ─── Route Handlers ────────────────────────────────────────────────────────

async function createCard(req, env) {
  let body = {};
  try { body = await req.json(); } catch {}

  const cardId = genCardId();
  const name   = (body.name || 'BrickPass Rider').slice(0, 60);
  const now    = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO cards (card_id, cardholder_name, balance, pass_type, pass_expiry, status, created_at)
     VALUES (?, ?, 0.00, NULL, NULL, 'ACTIVE', ?)`
  ).bind(cardId, name, now).run();

  await env.DB.prepare(
    `INSERT INTO transactions (card_id, type, amount, description, balance_after, created_at)
     VALUES (?, 'CARD_ISSUED', 0, 'BrickPass card issued', 0, ?)`
  ).bind(cardId, now).run();

  return json({ card_id: cardId, cardholder_name: name, balance: 0.00,
                pass_type: null, pass_expiry: null, status: 'ACTIVE', created_at: now }, 201);
}

async function getCard(cardId, env) {
  const card = await env.DB.prepare('SELECT * FROM cards WHERE card_id = ?').bind(cardId).first();
  if (!card) return err('Card not found', 404);
  return json(card);
}

async function reloadCard(cardId, req, env) {
  const body   = await req.json();
  const amount = parseFloat(body.amount);

  if (isNaN(amount) || amount < 5 || amount > 500)
    return err('Amount must be between $5.00 and $500.00');

  const card = await env.DB.prepare('SELECT * FROM cards WHERE card_id = ?').bind(cardId).first();
  if (!card)            return err('Card not found', 404);
  if (card.status !== 'ACTIVE') return err('Card is not active');

  const newBalance = Math.round((card.balance + amount) * 100) / 100;
  const now        = new Date().toISOString();

  await env.DB.prepare('UPDATE cards SET balance = ? WHERE card_id = ?').bind(newBalance, cardId).run();
  await env.DB.prepare(
    `INSERT INTO transactions (card_id, type, amount, description, balance_after, created_at)
     VALUES (?, 'RELOAD', ?, ?, ?, ?)`
  ).bind(cardId, amount, `Loaded $${amount.toFixed(2)} fare value`, newBalance, now).run();

  return json({ card_id: cardId, balance: newBalance, added: amount });
}

async function buyPass(cardId, req, env) {
  const body     = await req.json();
  const passType = body.pass_type;

  if (!PASS_PRICES[passType]) return err('Invalid pass type. Use "day" or "month"');

  const card = await env.DB.prepare('SELECT * FROM cards WHERE card_id = ?').bind(cardId).first();
  if (!card)            return err('Card not found', 404);
  if (card.status !== 'ACTIVE') return err('Card is not active');

  const now    = new Date();
  const expiry = new Date(now);
  if (passType === 'day') {
    expiry.setHours(23, 59, 59, 999);
  } else {
    expiry.setMonth(expiry.getMonth() + 1);
  }

  await env.DB.prepare(
    'UPDATE cards SET pass_type = ?, pass_expiry = ? WHERE card_id = ?'
  ).bind(passType, expiry.toISOString(), cardId).run();

  await env.DB.prepare(
    `INSERT INTO transactions (card_id, type, amount, description, balance_after, created_at)
     VALUES (?, 'PASS_PURCHASE', ?, ?, ?, ?)`
  ).bind(
    cardId, PASS_PRICES[passType],
    `${passType === 'day' ? 'Day Pass' : 'Monthly Pass'} purchased`,
    card.balance, now.toISOString()
  ).run();

  return json({ card_id: cardId, pass_type: passType,
                pass_expiry: expiry.toISOString(), cost: PASS_PRICES[passType] });
}

async function tapCard(cardId, env) {
  const card = await env.DB.prepare('SELECT * FROM cards WHERE card_id = ?').bind(cardId).first();

  if (!card)
    return json({ status: 'DECLINED', reason: 'INVALID_CARD',    message: 'Card not found' });
  if (card.status !== 'ACTIVE')
    return json({ status: 'DECLINED', reason: 'CARD_INACTIVE',   message: 'Card is suspended' });

  const now    = new Date();
  const nowISO = now.toISOString();

  // ── Check valid pass ──────────────────────────────────────────────────────
  if (card.pass_type && card.pass_expiry && new Date(card.pass_expiry) > now) {
    await env.DB.prepare(
      `INSERT INTO transactions (card_id, type, amount, description, balance_after, created_at)
       VALUES (?, 'TAP', 0, ?, ?, ?)`
    ).bind(cardId, `${card.pass_type === 'day' ? 'Day Pass' : 'Monthly Pass'} — Ride`,
           card.balance, nowISO).run();

    return json({ status: 'APPROVED', method: 'PASS', pass_type: card.pass_type,
                  pass_expiry: card.pass_expiry, cardholder_name: card.cardholder_name,
                  balance: card.balance });
  }

  // ── Check stored value ────────────────────────────────────────────────────
  if (card.balance < FARE) {
    return json({ status: 'DECLINED', reason: 'INSUFFICIENT_FUNDS',
                  message: `Balance $${card.balance.toFixed(2)} — need $${FARE.toFixed(2)}`,
                  balance: card.balance });
  }

  const newBalance = Math.round((card.balance - FARE) * 100) / 100;
  await env.DB.prepare('UPDATE cards SET balance = ? WHERE card_id = ?').bind(newBalance, cardId).run();
  await env.DB.prepare(
    `INSERT INTO transactions (card_id, type, amount, description, balance_after, created_at)
     VALUES (?, 'TAP', ?, 'Bus / Rail fare', ?, ?)`
  ).bind(cardId, -FARE, newBalance, nowISO).run();

  return json({ status: 'APPROVED', method: 'STORED_VALUE', fare: FARE,
                cardholder_name: card.cardholder_name, balance: newBalance });
}

async function getHistory(cardId, env) {
  const card = await env.DB.prepare('SELECT card_id FROM cards WHERE card_id = ?').bind(cardId).first();
  if (!card) return err('Card not found', 404);

  const { results } = await env.DB.prepare(
    `SELECT * FROM transactions WHERE card_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(cardId).all();

  return json(results);
}

// ─── Router ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, '');
    const method = request.method;

    try {
      if (path === '/api/cards' && method === 'POST')
        return await createCard(request, env);

      const m = path.match(/^\/api\/cards\/([A-Z0-9]+)(\/\w+)?$/);
      if (m) {
        const id  = m[1];
        const sub = m[2] || '';
        if (sub === ''        && method === 'GET')  return await getCard(id, env);
        if (sub === '/reload' && method === 'POST') return await reloadCard(id, request, env);
        if (sub === '/pass'   && method === 'POST') return await buyPass(id, request, env);
        if (sub === '/tap'    && method === 'POST') return await tapCard(id, env);
        if (sub === '/history'&& method === 'GET')  return await getHistory(id, env);
      }

      return err('Not found', 404);
    } catch (e) {
      console.error(e);
      return err('Internal server error', 500);
    }
  },
};
