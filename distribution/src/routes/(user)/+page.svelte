<section class="space-y-6">
	<div class="flex flex-wrap items-center gap-3">
		<span class="badge">Design System</span>
		<span class="badge">Clean Base</span>
		<span class="badge">Responsive</span>
	</div>
	<h1 class="h1">neuro Design System</h1>
	<p class="body-l max-w-2xl text-text-muted">
		Clean tokens, class-driven typography, and a minimal component set ready to scale. This
		page demonstrates the current foundations.
	</p>
	<div class="flex flex-wrap gap-3">
		<button class="btn btn-primary">Primary Action</button>
		<button class="btn btn-secondary">Secondary Action</button>
		<button class="btn btn-ghost">Ghost Action</button>
	</div>
</section>

<section class="grid gap-6 lg:grid-cols-3">
	<div class="card">
		<p class="body-s uppercase tracking-wide text-text-muted">Typography</p>
		<div class="mt-4 space-y-4">
			<div>
				<p class="h1">Heading One</p>
				<p class="body-s text-text-muted">.h1</p>
			</div>
			<div>
				<p class="h2">Heading Two</p>
				<p class="body-s text-text-muted">.h2</p>
			</div>
			<div>
				<p class="h3">Heading Three</p>
				<p class="body-s text-text-muted">.h3</p>
			</div>
			<div class="space-y-2">
				<p class="body-l">Body Large text for product storytelling.</p>
				<p class="body-m text-text-muted">Body Medium text for descriptions and UI copy.</p>
				<p class="body-s">Body Small text for helper notes.</p>
			</div>
		</div>
	</div>

	<div class="card">
		<p class="body-s uppercase tracking-wide text-text-muted">Colors</p>
		<div class="mt-4 grid gap-3">
			<div class="flex items-center gap-3">
				<div class="h-10 w-10 rounded-md border border-border bg-bg"></div>
				<div>
					<p class="body-m">Background</p>
					<p class="body-s text-text-muted">bg-bg</p>
				</div>
			</div>
			<div class="flex items-center gap-3">
				<div class="h-10 w-10 rounded-md border border-border bg-surface"></div>
				<div>
					<p class="body-m">Surface</p>
					<p class="body-s text-text-muted">bg-surface</p>
				</div>
			</div>
			<div class="flex items-center gap-3">
				<div class="h-10 w-10 rounded-md border border-border bg-surface-2"></div>
				<div>
					<p class="body-m">Surface 2</p>
					<p class="body-s text-text-muted">bg-surface-2</p>
				</div>
			</div>
			<div class="flex items-center gap-3">
				<div class="h-10 w-10 rounded-md bg-accent"></div>
				<div>
					<p class="body-m">Accent</p>
					<p class="body-s text-text-muted">bg-accent</p>
				</div>
			</div>
			<div class="flex items-center gap-3">
				<div class="h-10 w-10 rounded-md bg-success"></div>
				<div>
					<p class="body-m">Success</p>
					<p class="body-s text-text-muted">bg-success</p>
				</div>
			</div>
			<div class="flex items-center gap-3">
				<div class="h-10 w-10 rounded-md bg-warning"></div>
				<div>
					<p class="body-m">Warning</p>
					<p class="body-s text-text-muted">bg-warning</p>
				</div>
			</div>
		</div>
	</div>

	<div class="card">
		<p class="body-s uppercase tracking-wide text-text-muted">Inputs</p>
		<div class="mt-4 space-y-4">
			<div>
				<label class="body-s text-text-muted" for="name">Your name</label>
				<input class="input mt-2" id="name" placeholder="Alex Johnson" />
				<p class="input-help mt-2">Helper text for validation or guidance.</p>
			</div>
			<div>
				<label class="body-s text-text-muted" for="email">Work email</label>
				<input class="input mt-2" id="email" placeholder="alex@studio.com" />
			</div>
			<div class="flex flex-wrap gap-2">
				<span class="badge">Default</span>
				<span class="badge">Info</span>
				<span class="badge">Muted</span>
			</div>
		</div>
	</div>
</section>

<section class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<p class="body-s uppercase tracking-wide text-text-muted">Cards</p>
			<h2 class="h2 mt-2">Layout Modules</h2>
		</div>
		<button class="btn btn-secondary">View All</button>
	</div>
	<div class="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
		<div class="card">
			<p class="body-s uppercase tracking-wide text-text-muted">Module</p>
			<h3 class="h3 mt-3">Hero Section</h3>
			<p class="body-m mt-2 text-text-muted">
				Primary layout with headline, description, and call-to-action.
			</p>
		</div>
		<div class="card card-muted">
			<p class="body-s uppercase tracking-wide text-text-muted">Module</p>
			<h3 class="h3 mt-3">Feature Grid</h3>
			<p class="body-m mt-2 text-text-muted">
				Three-column layout optimized for responsive scaling.
			</p>
		</div>
		<div class="card">
			<p class="body-s uppercase tracking-wide text-text-muted">Module</p>
			<h3 class="h3 mt-3">CTA Banner</h3>
			<p class="body-m mt-2 text-text-muted">
				High-contrast block to drive action and capture attention.
			</p>
		</div>
	</div>
</section>

<section class="space-y-6">
	<p class="body-s uppercase tracking-wide text-text-muted">Spacing Scale</p>
	<div class="space-y-4">
		<div class="flex items-center gap-4">
			<div class="h-2 rounded-full bg-accent" style="width: var(--spacing-5)"></div>
			<p class="body-s text-text-muted">--spacing-5 (24px)</p>
		</div>
		<div class="flex items-center gap-4">
			<div class="h-2 rounded-full bg-accent" style="width: var(--spacing-7)"></div>
			<p class="body-s text-text-muted">--spacing-7 (40px)</p>
		</div>
		<div class="flex items-center gap-4">
			<div class="h-2 rounded-full bg-accent" style="width: var(--spacing-9)"></div>
			<p class="body-s text-text-muted">--spacing-9 (64px)</p>
		</div>
		<div class="flex items-center gap-4">
			<div class="h-2 rounded-full bg-accent" style="width: var(--spacing-11)"></div>
			<p class="body-s text-text-muted">--spacing-11 (96px)</p>
		</div>
	</div>
</section>
