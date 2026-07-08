const LOCAL_WEB_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3002",
];

export function getTrustedOrigins() {
  return uniqueOrigins([
    ...LOCAL_WEB_ORIGINS,
    process.env.WEB_ORIGIN,
    process.env.NEXT_PUBLIC_APP_URL,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]);
}

export function isAllowedCorsOrigin(origin: string) {
  if (getTrustedOrigins().includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "https:") return false;

    return (
      hostname === "sandbox.maidang.me" ||
      hostname.endsWith(".maidang.me") ||
      hostname === "vercel.app" ||
      hostname.endsWith(".vercel.app")
    );
  } catch {
    return false;
  }
}

function uniqueOrigins(origins: Array<string | undefined>) {
  return Array.from(
    new Set(origins.filter((origin): origin is string => Boolean(origin))),
  );
}
