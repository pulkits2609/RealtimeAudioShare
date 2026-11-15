import type { ReactElement } from 'react';
import { Tooltip } from 'radix-ui';

/** Radix/shadcn tooltip composition, styled with the shared meeting tokens. */
export function ControlHint({ text, children }: { text: string; children: ReactElement }) {
  return <Tooltip.Provider delayDuration={350}><Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="control-tooltip" sideOffset={7}>{text}<Tooltip.Arrow className="control-tooltip-arrow"/></Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>;
}
