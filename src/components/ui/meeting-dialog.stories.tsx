import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MeetingDialog } from './meeting-dialog';
import '../../meeting/style.css';
import '../../meeting/meeting-polish.css';

function DialogExample() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <><button ref={trigger} onClick={() => setOpen(true)}>Open settings</button><MeetingDialog open={open} onOpenChange={setOpen} title="Meeting settings" description="Device and listening preferences." returnFocus={trigger}><label htmlFor="example-volume">Interface volume</label><input id="example-volume" type="range" defaultValue={50}/></MeetingDialog></>;
}
const meta = { title: 'AudioShare/Meeting dialog', component: DialogExample, parameters: { layout: 'centered' } } satisfies Meta<typeof DialogExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FocusAndEscape: Story = {
  play: async ({ canvas, canvasElement }) => {
    const trigger = canvas.getByRole('button', { name: 'Open settings' });
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByRole('dialog', { name: 'Meeting settings' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(page.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(trigger).toHaveFocus();
  },
};
