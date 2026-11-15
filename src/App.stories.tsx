import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';
import App from './App';

const meta = {
  title: 'AudioShare/Connection', component: App,
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    const desktop = window.audioShareDesktop;
    const context = window.AudioContext;
    const media = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const theme = document.documentElement.dataset.theme;
    const keys = ['name', 'host', 'port', 'roomName', 'audioshare.notificationSounds', 'audioshare.theme'];
    const saved = new Map(keys.map(key => [key, localStorage.getItem(key)]));
    keys.forEach(key => localStorage.removeItem(key));
    localStorage.setItem('audioshare.notificationSounds', 'off');
    localStorage.setItem('audioshare.theme', 'light');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: fn(async () => []), addEventListener: fn(), removeEventListener: fn() } });
    window.audioShareDesktop = {
      platform: 'windows', listOutputDevices: fn(async () => ({ devices: [], defaultDeviceId: '' })),
      getCaptureCapabilities: fn(async () => ({ processExclusion: false, reason: 'No physical devices are accessed in Storybook.' })),
      startCapture: fn(async () => { throw new Error('Capture is unavailable in Storybook.'); }),
      stopCapture: fn(async () => {}), onAudio: fn(() => () => {}), onCaptureError: fn(() => () => {}),
    };
    return () => {
      window.audioShareDesktop = desktop; window.AudioContext = context;
      if (media) Object.defineProperty(navigator, 'mediaDevices', media); else Reflect.deleteProperty(navigator, 'mediaDevices');
      if (theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
      saved.forEach((value, key) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); });
    };
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connection: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText('Server address')).toHaveValue('localhost');
    await expect(canvas.getByLabelText('Port')).toHaveValue(9999);
    await expect(canvas.getByRole('button', { name: 'Join server' })).toBeEnabled();
    await expect(canvas.queryByRole('navigation', { name: 'Room workspace' })).not.toBeInTheDocument();
  },
};

export const ValidationError: Story = {
  play: async ({ canvas }) => {
    await userEvent.type(canvas.getByLabelText('Your name'), 'Pulkit');
    await userEvent.clear(canvas.getByLabelText('Server address'));
    await userEvent.type(canvas.getByLabelText('Server address'), 'bad host');
    await userEvent.click(canvas.getByRole('button', { name: 'Join server' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('Enter a hostname or IP address, without a protocol or path.');
    await expect(canvas.getByLabelText('Server address')).toBeEnabled();
  },
};

export const Connecting: Story = {
  beforeEach: () => {
    // Hold local audio initialization, before Room is imported or any server is contacted.
    window.AudioContext = class {
      resume() { return new Promise<void>(() => {}); }
      close() { return Promise.resolve(); }
    } as unknown as typeof AudioContext;
  },
  play: async ({ canvas }) => {
    await userEvent.type(canvas.getByLabelText('Your name'), 'Pulkit');
    await userEvent.click(canvas.getByRole('button', { name: 'Join server' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Connecting to server');
    await expect(canvas.getByLabelText('Your name')).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Cancel connection' })).toBeEnabled();
  },
};
