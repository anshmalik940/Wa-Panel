const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { asyncHandler: ah } = require('../utils/httpError');
const { pageParams, pageResult } = require('../utils/pagination');
const { audit } = require('../utils/audit');
const { addCredits, deductCredits, listLedger } = require('../services/credits');

const creditSchema = z.object({
  action: z.enum(['add', 'deduct']),
  amount: z.coerce.number().int().min(1, 'Enter a whole number of at least 1').max(100000000),
  note: z.string().trim().max(300).default(''),
});

/**
 * Adds GET/POST /:id/credits to a router.
 * `loadTarget(req)` must return the user whose wallet is changed (already scoped to what the actor may manage).
 */
function attachCreditRoutes(router, loadTarget, targetType) {
  router.get(
    '/:id/credits',
    ah(async (req, res) => {
      const target = await loadTarget(req);
      const pp = pageParams(req.query, { defLimit: 20 });
      const { rows, total } = await listLedger(target._id, { page: pp.page, limit: pp.limit });
      res.json({ balance: target.credits || 0, ...pageResult(rows, total, pp) });
    }),
  );

  router.post(
    '/:id/credits',
    validate(creditSchema),
    ah(async (req, res) => {
      const target = await loadTarget(req);
      const { action, amount, note } = req.body;
      const fn = action === 'add' ? addCredits : deductCredits;
      const out = await fn({ actor: req.user, target, amount, note });
      await audit(req, `credits.${action}`, { targetType, targetId: target._id, ownerId: target._id, meta: { amount, note, balanceAfter: out.target.credits } });
      res.json({ balance: out.target.credits, yourBalance: out.actor ? out.actor.credits : undefined });
    }),
  );
}

module.exports = { attachCreditRoutes };
