import { useState } from "react";

/**
 * Downloads a file from an app route. App Bridge adds the session token to fetch
 * requests made inside the embedded app, so the route can authenticate normally.
 */
export function DownloadButton({ href, filename, children }: { href: string; filename: string; children: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`ss-btn${busy ? " loading" : ""}`}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch(href);
          if (!res.ok) throw new Error(`Download failed (${res.status})`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (err) {
          (window as any).shopify?.toast?.show(err instanceof Error ? err.message : "Download failed", { isError: true });
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}
