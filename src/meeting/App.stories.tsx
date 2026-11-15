import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';
import App from './App';

const meta = {
  title: 'AudioShare/Meeting connection',
  component: App,
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    const previous = window.audioShareDesktop;
    const saved = new Map(['name', 'host', 'port', 'roomName', 'audioshare.notificationSounds'].map(key => [key, localStorage.getItem(key)]));
    ['name', 'host', 'port', 'roomName'].forEach(key => localStorage.removeItem(key));
    localStorage.setItem('audioshare.notificationSounds', 'off');
    window.audioShareDesktop = {
      platform: 'windows',
      listOutputDevices: fn(async () => ({ devices: [], defaultDeviceId: '' })),
      getCaptureCapabilities: fn(async () => ({ processExclusion: false, reason: 'Story preview uses no capture devices.' })),
      startCapture: fn(async () => { throw new Error('Capture is unavailable in Storybook.'); }),
      stopCapture: fn(async () => {}),
      onAudio: fn(() => () => {}),
      onCaptureError: fn(() => () => {}),
    };
    return () => { window.audioShareDesktop = previous; saved.forEach((value, key) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }); };
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText('Server address')).toHaveValue('localhost');
    await expect(canvas.getByLabelText('Port')).toHaveValue(9999);
    await expect(canvas.queryByRole('navigation', { name: 'Room workspace' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Join server' })).toBeEnabled();
  },
};
export const AdvancedOptions: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByText('Connection options'));
    const secure = canvas.getByRole('checkbox', { name: 'Use secure connection (TLS / WSS)' });
    await expect(secure).not.toBeChecked();
    await userEvent.click(secure);
    await expect(secure).toBeChecked();
    await userEvent.type(canvas.getByLabelText('Your name'), 'Pulkit');
    await expect(canvas.getByLabelText('Your name')).toHaveValue('Pulkit');
    await expect(canvas.getByLabelText('Server access token')).toHaveAttribute('type', 'password');
  },
};
