<script lang="ts">
	import '../../app.css';
	import type { LayoutProps } from '../$types';
	import { onNavigate } from '$app/navigation';
	import { browser } from '$app/environment';
	import { page } from '$app/state';

	const { children, data }: LayoutProps = $props();

	onNavigate(() => {
		if (
			!browser ||
			!('startViewTransition' in document) ||
			page.url.pathname.startsWith('/photos')
		) {
			return;
		}

		return new Promise((resolve) => {
			// @ts-expect-error
			document.startViewTransition(() => new Promise(resolve));
		});
	});
</script>

<svelte:head>
	<title>Neuro Distribution</title>
</svelte:head>

<div class="relative py-10 md:py-12">
	<main class="app-container min-h-screen space-y-10" id="main">
		{@render children?.()}
	</main>
</div>
