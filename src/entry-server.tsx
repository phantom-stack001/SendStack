import { renderToString } from "react-dom/server";
import { HelmetProvider, type HelmetServerState } from "react-helmet-async";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { appRoutes } from "@/app/routes";

export async function render(url: string) {
  const helmetContext: { helmet?: HelmetServerState } = {};
  const memoryRouter = createMemoryRouter(appRoutes, { initialEntries: [url] });

  const appHtml = renderToString(
    <HelmetProvider context={helmetContext}>
      <RouterProvider router={memoryRouter} />
    </HelmetProvider>,
  );

  const helmet = helmetContext.helmet;
  const headHtml = [
    helmet?.title.toString() ?? "",
    helmet?.meta.toString() ?? "",
    helmet?.link.toString() ?? "",
  ].join("");

  return { appHtml, headHtml };
}
