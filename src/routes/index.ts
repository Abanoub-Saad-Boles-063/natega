import { createFileRoute } from "@tanstack/react-router";
// Serve the uploaded Arabic Thanaweya results page as-is at "/".
import homeHtml from "./_home.html?raw";

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: async () =>
        new Response(homeHtml, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=0, must-revalidate",
          },
        }),
    },
  },
});