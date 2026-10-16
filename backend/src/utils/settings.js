const { z } = require('zod');
const { Setting } = require('../models');

const DEFAULTS = {
  brandName: 'WA Campaign Panel',
  supportEmail: '',
  defaultMonthlyMessageLimit: 1000,
  defaultContactLimit: 5000,
  mockFailureRate: 0,
  mockDeliveryDelayMs: 3000,
  mockReadDelayMs: 4000,
  creditsPerMessage: 1,
  creditsPerCall: 1,
  qrDelayMinMs: 3000,
  qrDelayMaxMs: 8000,
  waHttpDelayMs: 1000,
  campaignBatchSize: 5,
  campaignBatchDelayMs: 1000,
  campaignFailurePauseThreshold: 5,
  finishedCampaignRetentionLimit: 10,
  allowQrForNewUsers: false,
};

const updateSchema = z
  .object({
    brandName: z.string().trim().min(1).max(60),
    supportEmail: z.string().trim().max(200).refine((v) => !v || z.string().email().safeParse(v).success, 'Invalid email'),
    defaultMonthlyMessageLimit: z.coerce.number().int().min(0).max(10000000),
    defaultContactLimit: z.coerce.number().int().min(0).max(10000000),
    mockFailureRate: z.coerce.number().min(0).max(100),
    mockDeliveryDelayMs: z.coerce.number().int().min(0).max(600000),
    mockReadDelayMs: z.coerce.number().int().min(0).max(600000),
    creditsPerMessage: z.coerce.number().int().min(0).max(100000),
    creditsPerCall: z.coerce.number().int().min(0).max(100000),
    qrDelayMinMs: z.coerce.number().int().min(500).max(600000),
    qrDelayMaxMs: z.coerce.number().int().min(500).max(600000),
    waHttpDelayMs: z.coerce.number().int().min(500).max(600000),
    campaignBatchSize: z.coerce.number().int().min(1).max(50),
    campaignBatchDelayMs: z.coerce.number().int().min(0).max(600000),
    campaignFailurePauseThreshold: z.coerce.number().int().min(1).max(50),
    finishedCampaignRetentionLimit: z.coerce.number().int().min(1).max(1000),
    allowQrForNewUsers: z.coerce.boolean(),
  })
  .partial()
  .strict();

async function getSettings() {
  const docs = await Setting.find().lean();
  const out = { ...DEFAULTS };
  for (const d of docs) if (d.key in DEFAULTS) out[d.key] = d.value;
  return out;
}

async function updateSettings(patch) {
  await Promise.all(
    Object.entries(patch).map(([key, value]) => Setting.updateOne({ key }, { $set: { value } }, { upsert: true })),
  );
  return getSettings();
}

module.exports = { DEFAULTS, updateSchema, getSettings, updateSettings };
