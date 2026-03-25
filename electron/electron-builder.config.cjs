const path = require("path");

const base = require("./electron-builder.json");
base.mac = base.mac || {};

// Custom sign function for macOS
base.mac.sign = path.resolve(__dirname, "signing/mac-sign.js");

module.exports = base;
