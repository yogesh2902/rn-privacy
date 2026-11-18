// Expo config plugin entry: "plugins": ["rn-privacy"] in app.json.
// CommonJS so every Expo SDK can require() it, whatever the Node version.
module.exports = require('./dist/expo-plugin.js').default;
