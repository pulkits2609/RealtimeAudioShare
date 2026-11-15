import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { ConnectionStatus } from './connection-status';
import '../../meeting/style.css';
import '../../meeting/meeting-polish.css';

const meta = { title: 'AudioShare/Connection status', component: ConnectionStatus, args: { state: 'offline' }, parameters: { layout: 'centered' } } satisfies Meta<typeof ConnectionStatus>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Offline: Story = {};
export const Connecting: Story = { args: { state: 'connecting' }, play: async ({ canvas }) => { await expect(canvas.getByRole('status')).toHaveTextContent('Connecting to server'); } };
export const Connected: Story = { args: { state: 'connected', elapsed: 754000 }, play: async ({ canvas }) => { await expect(canvas.getByLabelText('Connected duration 12:34')).toBeVisible(); } };
export const Reconnecting: Story = { args: { state: 'reconnecting', elapsed: 754000 }, play: async ({ canvas }) => { await expect(canvas.getByRole('status')).toHaveTextContent('Reconnecting'); await expect(canvas.getByText('12:34')).toBeVisible(); } };
