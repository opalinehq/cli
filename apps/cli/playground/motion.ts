/* Animation storyboard
 *       0ms  ON/OFF text updates; knob starts at its previous position.
 *  duration  knob arrives at the other end of the three-cell track.
 * New screen: fade from 30% → 100% opacity using the preview fade duration.
 * Both animations are interruptible and disabled by reduced-motion settings.
 */
interface SwitchSnapshot {
	position: string | undefined;
	offset: number;
}

export function captureSwitches(
	terminal: HTMLElement,
): Map<string, SwitchSnapshot> {
	const switches = new Map<string, SwitchSnapshot>();
	for (const row of terminal.querySelectorAll<HTMLElement>(
		"[data-repository]",
	)) {
		const knob = row.querySelector<HTMLElement>(".switch-knob");
		const track = row.querySelector<HTMLElement>(".switch-track");
		if (knob && track && row.dataset.repository)
			switches.set(row.dataset.repository, {
				position: knob.dataset.position,
				offset:
					knob.getBoundingClientRect().x - track.getBoundingClientRect().x,
			});
	}
	return switches;
}

export function animateSwitches(
	terminal: HTMLElement,
	previous: Map<string, SwitchSnapshot>,
	duration: number,
) {
	if (!duration) return;
	for (const row of terminal.querySelectorAll<HTMLElement>(
		"[data-repository]",
	)) {
		const before = previous.get(row.dataset.repository ?? "");
		const knob = row.querySelector<HTMLElement>(".switch-knob");
		const track = row.querySelector<HTMLElement>(".switch-track");
		if (!before || !knob || !track || before.position === knob.dataset.position)
			continue;
		const delta =
			before.offset -
			(knob.getBoundingClientRect().x - track.getBoundingClientRect().x);
		knob.animate(
			[{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }],
			{ duration, easing: "ease-out" },
		);
	}
}

export function animateScreen(terminal: HTMLElement, duration: number) {
	for (const animation of terminal.getAnimations()) animation.cancel();
	if (duration)
		terminal.animate([{ opacity: 0.3 }, { opacity: 1 }], {
			duration,
			easing: "ease-out",
		});
}
