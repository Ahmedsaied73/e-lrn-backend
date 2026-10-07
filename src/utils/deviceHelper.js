'use strict';

const UAParser = require('ua-parser-js');

function parseUserAgent(uaString = '') {
  const parser = new UAParser(uaString);
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const device = parser.getDevice();

  const browserName = browser.name ? `${browser.name} ${browser.major || ''}`.trim() : 'Unknown Browser';
  const osName = os.name ? `${os.name} ${os.version || ''}`.trim() : 'Unknown OS';

  let deviceType = 'DESKTOP';
  if (device.type === 'mobile') deviceType = 'MOBILE';
  else if (device.type === 'tablet') deviceType = 'TABLET';

  let deviceName = `${browserName} on ${osName}`;
  if (device.vendor && device.model) {
    deviceName = `${device.vendor} ${device.model} (${browserName})`;
  } else if (osName.includes('iOS') || osName.includes('Android')) {
    // If vendor/model not in generic UA, still format nicely
    deviceName = `${osName} (${browserName})`;
  }

  return {
    deviceName,
    deviceType,
    browser: browserName,
    os: osName,
  };
}

function isValidDeviceId(id) {
  return typeof id === 'string' && id.trim().length >= 8 && id.trim().length <= 64;
}

module.exports = { parseUserAgent, isValidDeviceId };
