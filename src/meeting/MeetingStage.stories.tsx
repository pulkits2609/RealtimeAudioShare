import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';
import { MeetingStage } from './MeetingStage';
import './style.css';
import './workspace.css';
import './theme.css';
import './meeting.css';
import './meeting-polish.css';

const meta = {
  title: 'AudioShare/Meeting stage',
  component: MeetingStage,
  args: { name: 'Preview host', microphone: false, peers: [], videos: [], camera: null, screen: null, receiveVideo: true, onQuality: fn() },
  decorators: [Story => <div className="room-shell joined" style={{ padding: 24 }}><p>Story fixture · no server or devices connected</p><Story /></div>],
} satisfies Meta<typeof MeetingStage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingForOthers: Story = {
  play: async ({ canvas }) => { await expect(canvas.getByText('Preview host')).toBeVisible(); await expect(canvas.getByText('Mic off')).toBeVisible(); },
};
export const Participants: Story = {
  args: { peers: [
    { id: 'story-a', name: 'Preview participant', microphone: true, speaking: true, streaming: false },
    { id: 'story-b', name: 'Preview listener', microphone: false, streaming: false },
  ] },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Speaking')).toBeVisible();
    await expect(canvas.getByText('Preview listener')).toBeVisible();
    const pin = canvas.getByRole('button', { name: 'Pin Preview participant · Camera' });
    await userEvent.click(pin);
    await expect(canvas.getByRole('button', { name: 'Unpin Preview participant · Camera' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Focus Preview listener · Camera' }));
    await expect(canvas.getByRole('combobox', { name: 'Meeting layout' })).toHaveValue('focus');
    await userEvent.click(canvas.getByRole('button', { name: 'Return to gallery' }));
    await expect(canvas.getByRole('combobox', { name: 'Meeting layout' })).toHaveValue('grid');
  },
};
export const AudioOnly: Story = { args: { receiveVideo: false } };
export const DeviceAudioSources: Story = { args: { sharing: true, localAudioLevel: .12, peers: [{ id: 'story-source', name: 'Preview sharer', microphone: true, streaming: true }], onSourceVolume: fn() } };
