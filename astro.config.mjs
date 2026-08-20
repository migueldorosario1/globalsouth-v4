// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
    site: 'https://www.globalsouth.news',
    redirects: {
        '/blog/brief-202608151436-professor-ismail-mirandi-the-iranians-have-decided-that-enough-is-enou': '/blog/brief-202608151436-professor-mohammad-marandi-the-iranians-have-decided-that-enough-is-enou',
    },
    integrations: [
		mdx(),
		sitemap({
			filter: (page) => {
				const path = new URL(page).pathname;
				return !/(^|\/)(tags|teste|preview)(\/|-|$)/.test(path);
			},
		}),
	],
});
