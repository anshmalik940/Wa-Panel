const dns = require('dns');
const mongoose = require('mongoose');
require('./models');

async function connectDb(uri) {
  // Some ISP/router DNS servers refuse the SRV lookup used by mongodb+srv:// URIs (querySrv ECONNREFUSED).
  // Setting DNS_SERVERS=8.8.8.8,8.8.4.4 in .env makes Node use public DNS for this process.
  if (process.env.DNS_SERVERS) {
    dns.setServers(process.env.DNS_SERVERS.split(',').map((x) => x.trim()).filter(Boolean));
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  // wait for every declared index (unique keys, lookups) to exist before serving traffic
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}

async function disconnectDb() {
  await mongoose.disconnect();
}

module.exports = { connectDb, disconnectDb, mongoose };
