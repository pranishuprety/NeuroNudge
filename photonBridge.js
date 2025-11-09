// photonBridge.js
// Lazy-loads the Photon iMessage Kit SDK and sends messages when available.

const CDN_ENDPOINT = "https://cdn.jsdelivr.net/npm/@photon-ai/imessage-kit/+esm";
let sdkPromise = null;

async function getSdk() {
  if (!sdkPromise) {
    sdkPromise = import(CDN_ENDPOINT)
      .then((module) => {
        if (!module?.IMessageSDK) {
          throw new Error("Photon iMessage SDK not available.");
        }
        return new module.IMessageSDK();
      })
      .catch((error) => {
        console.warn("[Photon] Unable to load iMessage SDK", error);
        return null;
      });
  }
  return sdkPromise;
}

export async function sendParentAlert(phoneNumber, message) {
  if (!phoneNumber || !message) {
    return { sent: false, error: "Missing phone number or message." };
  }
  const sdk = await getSdk();
  if (!sdk) {
    return { sent: false, error: "SDK unavailable." };
  }
  try {
    await sdk.send(phoneNumber, message);
    return { sent: true };
  } catch (error) {
    console.warn("[Photon] Failed to send iMessage", error);
    return { sent: false, error: error.message };
  }
}

