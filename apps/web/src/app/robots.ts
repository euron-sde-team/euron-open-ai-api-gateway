import type { MetadataRoute } from "next";

/**
 * Nothing here is for search engines: chats need a session, and shared chats are reachable
 * only by their unguessable link (their pages also send noindex).
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
