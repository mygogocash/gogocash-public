/**
 * Removes an RPC URL (a secret: providers put API keys in the path or query)
 * from any text before it is printed. Every URL in the text is replaced, and
 * so are the configured URL's host and hostname on their own, because
 * network errors quote the hostname (`getaddrinfo ENOTFOUND <host>`).
 */
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const MIN_STANDALONE = 4;

export function redactRpcUrl(text: string, rpcUrl: string | undefined): string {
  let out = text;
  if (rpcUrl !== undefined && rpcUrl !== "") {
    const needles = new Set<string>([rpcUrl, rpcUrl.replace(/\/+$/, "")]);
    try {
      const url = new URL(rpcUrl);
      // A short part on its own (a 1-3 character user name, say) would match
      // inside ordinary output and corrupt it, so parts shorter than 4 are
      // only removed as part of the URL or its "user:password@" prefix.
      const userinfo = url.password === "" ? url.username : `${url.username}:${url.password}`;
      if (userinfo !== "") needles.add(`${userinfo}@`);
      for (const part of [url.href, url.origin, url.host, url.hostname, url.pathname, url.search, url.username, url.password]) {
        if (part.length >= MIN_STANDALONE && part !== "/") needles.add(part);
      }
    } catch {
      // Not a parseable URL: the literal value is still removed.
    }
    for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
      if (needle !== "") out = out.split(needle).join("<rpc-url>");
    }
  }
  return out.replace(ANY_URL, "<url>");
}
