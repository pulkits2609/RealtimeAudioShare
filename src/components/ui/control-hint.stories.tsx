import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ControlHint } from './control-hint';
import '../../meeting/style.css';
import '../../meeting/meeting-polish.css';

const meta = {
  title: 'AudioShare/Control hint', component: ControlHint,
  args: { text: 'Your microphone is separate from shared audio.', children: <button type="button">Microphone</button> },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ControlHint>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyboardFocus: Story = {
  play: async ({ canvas, canvasElement }) => {
    canvas.getByRole('button', { name: 'Microphone' }).focus();
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByRole('tooltip')).toHaveTextContent('Your microphone is separate from shared audio.');
    await userEvent.keyboard('{Escape}');
    await expect(page.queryByRole('tooltip')).not.toBeInTheDocument();
  },
};
