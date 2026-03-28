async function createGatewayClient(options) {
  const module = await import("./gateway_client.js");
  return new module.GatewayClient(options);
}

function formatPairingHint(detail = {}) {
  const requestId = typeof detail.requestId === "string" && detail.requestId.trim()
    ? ` Request ID: ${detail.requestId.trim()}.`
    : "";
  const reason = typeof detail.reason === "string" && detail.reason.trim()
    ? ` Reason: ${detail.reason.trim()}.`
    : "";

  return `Connection requires device pairing before chat is authorized.${reason}${requestId} Approve the pending device and try again.`;
}

export async function probeGatewayConnection(
  {
    url,
    token,
    deviceToken,
    debugEvents = false,
    createClient = createGatewayClient,
  },
) {
  let latestDiagnosticHint = "";
  let pairingDetail = null;
  let issuedDeviceToken = "";

  const client = await createClient({
    url,
    token,
    deviceToken,
    debugEvents,
    onEvent: () => {},
    onState: (status, detail) => {
      if (status === "socket_diagnostic" && typeof detail?.hint === "string") {
        latestDiagnosticHint = detail.hint;
      }

      if (status === "pairing_required") {
        pairingDetail = detail || {};
      }

      if (status === "device_token_issued" && typeof detail?.deviceToken === "string") {
        issuedDeviceToken = detail.deviceToken;
      }
    },
  });

  try {
    await client.connect();
    return {
      success: true,
      deviceToken: issuedDeviceToken,
      note: issuedDeviceToken
        ? "Connection successful. The gateway issued a fresh paired device token."
        : "Connection successful.",
    };
  } catch (error) {
    if (pairingDetail) {
      return {
        success: false,
        error: "pairing_required",
        hint: formatPairingHint(pairingDetail),
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: "connect_failed",
      hint: latestDiagnosticHint || message || "Unknown connection error.",
    };
  } finally {
    client.close?.();
  }
}
