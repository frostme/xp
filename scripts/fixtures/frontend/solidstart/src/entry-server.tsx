import { createHandler, StartServer } from "@solidjs/start/server";

export default createHandler((event) => {
  event.response.headers.set("cache-control", "private, no-store");
  return (
    <StartServer
      document={({ assets, children, scripts }) => (
        <html lang="en">
          <head>{assets}</head>
          <body>
            <div id="app">{children}</div>
            {scripts}
          </body>
        </html>
      )}
    />
  );
});
