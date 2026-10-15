const { Campaign, CampaignMessage, CampaignArchive, User } = require('../models');
const { getSettings } = require('../utils/settings');

const FINISHED = ['completed', 'cancelled', 'failed'];
const MESSAGE_DELETE_BATCH = 1000;
const CAMPAIGN_BATCH = 25;

async function archiveCampaign(campaign) {
  if (await CampaignArchive.exists({ campaignId: campaign._id, ownerId: campaign.ownerId })) return;
  const messageBuckets = await CampaignMessage.aggregate([
    { $match: { campaignId: campaign._id, ownerId: campaign.ownerId } },
    { $group: { _id: { at: '$createdAt', status: '$status' }, count: { $sum: 1 } } },
    { $project: { _id: 0, at: '$_id.at', status: '$_id.status', count: 1 } },
  ]);
  try {
    await CampaignArchive.create({
      ownerId: campaign.ownerId,
      campaignId: campaign._id,
      createdAt: campaign.createdAt,
      status: campaign.status,
      channel: campaign.channel || 'whatsapp',
      messageBuckets,
    });
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
  }
}

async function removeFinishedCampaign(campaignId, ownerId) {
  const campaign = await Campaign.findOne({ _id: campaignId, ownerId, status: { $in: FINISHED } });
  if (!campaign) return false;
  await archiveCampaign(campaign);
  const stillFinished = await Campaign.findOne({ _id: campaign._id, ownerId, status: { $in: FINISHED } }).select('_id');
  if (!stillFinished) return false;

  while (await CampaignMessage.exists({ campaignId: campaign._id, ownerId })) {
    const rows = await CampaignMessage.find({ campaignId: campaign._id, ownerId }).select('_id').limit(MESSAGE_DELETE_BATCH).lean();
    if (!rows.length) break;
    await CampaignMessage.deleteMany({ campaignId: campaign._id, ownerId, _id: { $in: rows.map((row) => row._id) } });
  }
  const deleted = await Campaign.deleteOne({ _id: campaign._id, ownerId, status: { $in: FINISHED } });
  return deleted.deletedCount === 1;
}

async function cleanupOwner(ownerId, limitOverride) {
  const settings = limitOverride === undefined ? await getSettings() : null;
  const keep = Math.max(1, Number(limitOverride === undefined ? settings.finishedCampaignRetentionLimit : limitOverride) || 10);
  let removed = 0;
  while (true) {
    const oldCampaigns = await Campaign.find({ ownerId, status: { $in: FINISHED } })
      .sort({ createdAt: -1, _id: -1 })
      .skip(keep)
      .limit(CAMPAIGN_BATCH)
      .select('_id')
      .lean();
    if (!oldCampaigns.length) break;
    let batchRemoved = 0;
    for (const campaign of oldCampaigns) {
      if (await removeFinishedCampaign(campaign._id, ownerId)) batchRemoved += 1;
    }
    removed += batchRemoved;
    if (!batchRemoved) break;
  }
  return removed;
}

async function cleanupAll() {
  let owners = 0;
  let removed = 0;
  for await (const user of User.find({ role: { $in: ['customer', 'reseller'] } }).select('_id').lean().cursor({ batchSize: 50 })) {
    owners += 1;
    removed += await cleanupOwner(user._id);
  }
  return { owners, removed };
}

module.exports = { FINISHED, archiveCampaign, removeFinishedCampaign, cleanupOwner, cleanupAll };
