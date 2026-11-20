import type { LinksFunction } from "react-router";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import stylesheet from "./styles/stocksense.css?url";
import { APPEARANCE_BOOT_SCRIPT, DEFAULT_APPEARANCE } from "./lib/appearance";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com/" },
  { rel: "stylesheet", href: "https://cdn.shopify.com/static/fonts/inter/v4/styles.css" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&family=Montserrat:wght@600;700;800&display=swap",
  },
  { rel: "stylesheet", href: stylesheet },
];

export default function App() {
  return (
    <html
      lang="en"
      data-theme={DEFAULT_APPEARANCE.theme}
      data-accent={DEFAULT_APPEARANCE.accent}
      data-density={DEFAULT_APPEARANCE.density}
      suppressHydrationWarning
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* Apply the saved theme before paint so there is no flash of the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
