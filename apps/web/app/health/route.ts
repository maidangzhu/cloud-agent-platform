export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    ok: true,
    service: "web",
    apiProxyConfigured: Boolean(process.env.API_PROXY_TARGET),
  });
}
