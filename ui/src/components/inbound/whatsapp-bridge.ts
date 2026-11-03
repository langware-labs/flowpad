import { dataManager, QueryRequest, ServiceEndpoint, WEB_AUDIENCES, WebApp } from '@sdk';

/** The webapp a WhatsApp bridge (waha-service) declares: its admin page pairs a phone by QR. */
export const WHATSAPP_BRIDGE_APP = 'waha-admin';

/**
 * Where the WhatsApp bridge's admin page is served — the placement's route of the `waha-admin` webapp — or ''
 * when no placement serves one. Its QR pairs the person's own phone; the bridge then registers the hub webhook.
 */
export async function whatsappBridgeUrl(): Promise<string> {
  const apps = await dataManager.query<WebApp>(
    new QueryRequest({ type: WebApp.type, query: { match: { name: WHATSAPP_BRIDGE_APP } }, name: 'whatsappBridge' }),
  );
  const ids = new Set(apps.map((app) => app.id));
  if (!ids.size) return '';
  const proxies = await Promise.all(
    WEB_AUDIENCES.map((audience) =>
      dataManager.query<ServiceEndpoint>(
        new QueryRequest({
          type: ServiceEndpoint.type,
          query: { match: { subkind: audience } },
          name: 'whatsappBridge',
        }),
      ),
    ),
  );
  const served = proxies
    .flat()
    .flatMap((proxy) => proxy.served())
    .find((app) => app.mount !== null && !!app.webapp_id && ids.has(app.webapp_id));
  return served?.serviceUrl() ?? '';
}
