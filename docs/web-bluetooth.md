# Web Bluetooth API

The web app relies on the Web Bluetooth API to communicate with the Fairbuds, but this feature is not yet supported in all browsers.

See current browser support on [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API#browser_compatibility) or [Can I use…](https://caniuse.com/web-bluetooth).

## Linux

Chromium-based browsers do not currently have Bluetooth support enabled by default on Linux. To manually enable it, paste `chrome://flags/#enable-web-bluetooth` into your address bar and enable the flag.

## Android

On Android, you may need to enable precise location and nearby device permissions for the browser in order to use Web Bluetooth. You can do this in your device's settings under Applications > _\[Your browser\]_ > Permissions.