<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes, MouseEventHandler } from 'svelte/elements';

	type Styles = 'default' | 'simple' | 'ghost';

	interface BaseProps {
		label?: string;
		disabled?: boolean;
		children: Snippet;
		style?: Styles;
		type?: HTMLButtonAttributes['type'];
		className?: string;
	}

	interface ButtonProps extends BaseProps {
		as?: 'button';
		onclick?: MouseEventHandler<HTMLButtonElement>;
	}

	interface LinkProps extends BaseProps {
		as: 'a';
		onclick?: MouseEventHandler<HTMLAnchorElement>;
		href: string;
		rel?: string;
		target?: string;
	}

	type Props = ButtonProps | LinkProps;

	const props: Props = $props();

	const cls: Record<Styles, string> = {
		default: 'btn btn-primary disabled:opacity-60',
		simple: 'btn btn-ghost',
		ghost: 'btn btn-secondary disabled:opacity-60'
	};

	const onClick = (event: MouseEvent) => {
		if (props.onclick) {
			props.onclick(event as never);
		}
	};
</script>

{#if props.as === 'a'}
	<a
		rel={props.rel}
		target={props.target}
		class="{cls[
			props.style ?? 'default'
		]} cursor-pointer {props.className ? props.className : ''}"
		onclick={onClick}
		aria-label={props.label}
		href={props.href}
	>
		{@render props.children()}
	</a>
{:else}
	<button
		type={props.type ?? 'button'}
		class="{cls[
			props.style ?? 'default'
		]} cursor-pointer {props.className ? props.className : ''}"
		onclick={onClick}
		disabled={props.disabled}
		aria-label={props.label}
	>
		{@render props.children()}
	</button>
{/if}
