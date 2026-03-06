12:04:10.635 Running build in Portland, USA (West) – pdx1 (Turbo Build Machine)
12:04:10.635 Build machine configuration: 30 cores, 60 GB
12:04:10.644 Cloning github.com/hoenmamou/dsw-scheduler (Branch: main, Commit: 113aa36)
12:04:10.644 Skipping build cache, deployment was triggered without cache.
12:04:11.147 Cloning completed: 503.000ms
12:04:12.312 Running "vercel build"
12:04:12.823 Vercel CLI 50.28.0
12:04:13.062 Installing dependencies...
12:04:17.290 npm warn deprecated next@14.1.0: This version has a security vulnerability. Please upgrade to a patched version. See https://nextjs.org/blog/security-update-2025-12-11 for more details.
12:04:17.308 
12:04:17.309 added 33 packages in 4s
12:04:17.309 
12:04:17.309 3 packages are looking for funding
12:04:17.309   run `npm fund` for details
12:04:17.345 Detected Next.js version: 14.1.0
12:04:17.346 Running "npm run build"
12:04:17.427 
12:04:17.427 > dsw-scheduler@1.0.0 build
12:04:17.427 > next build
12:04:17.427 
12:04:17.806 Attention: Next.js now collects completely anonymous telemetry regarding usage.
12:04:17.807 This information is used to shape Next.js' roadmap and prioritize features.
12:04:17.807 You can learn more, including how to opt-out if you'd not like to participate in this anonymous program, by visiting the following URL:
12:04:17.807 https://nextjs.org/telemetry
12:04:17.807 
12:04:17.874    ▲ Next.js 14.1.0
12:04:17.874 
12:04:17.881    Creating an optimized production build ...
12:04:22.613  ✓ Compiled successfully
12:04:22.614    Linting and checking validity of types ...
12:04:22.671    Collecting page data ...
12:04:23.428    Generating static pages (0/4) ...
12:04:23.622 
   Generating static pages (1/4) 
12:04:23.622 
   Generating static pages (2/4) 
12:04:23.623 TypeError: Cannot read properties of null (reading 'useState')
12:04:23.623     at t.useState (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:109626)
12:04:23.623     at 7477 (/vercel/path0/.next/server/app/page.js:43:26952)
12:04:23.623     at t (/vercel/path0/.next/server/webpack-runtime.js:1:127)
12:04:23.623     at F (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:94693)
12:04:23.623     at /vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:97108
12:04:23.623     at W._fromJSON (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:97546)
12:04:23.623     at JSON.parse (<anonymous>)
12:04:23.623     at N (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:94414)
12:04:23.623     at t (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:100799)
12:04:23.623 
12:04:23.624 Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error
12:04:23.624 
12:04:23.624 TypeError: Cannot read properties of null (reading 'useState')
12:04:23.624     at t.useState (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:109626)
12:04:23.624     at 7477 (/vercel/path0/.next/server/app/page.js:43:26952)
12:04:23.624     at t (/vercel/path0/.next/server/webpack-runtime.js:1:127)
12:04:23.624     at F (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:94693)
12:04:23.624     at /vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:97108
12:04:23.624     at W._fromJSON (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:97546)
12:04:23.624     at JSON.parse (<anonymous>)
12:04:23.624     at N (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:94414)
12:04:23.624     at t (/vercel/path0/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js:12:100799)
12:04:23.624 
   Generating static pages (3/4) 
12:04:23.624 
 ✓ Generating static pages (4/4) 
12:04:23.633 
12:04:23.633 > Export encountered errors on following paths:
12:04:23.633 	/page: /
12:04:23.660 Error: Command "npm run build" exited with 1
