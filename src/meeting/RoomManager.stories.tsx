import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { RoomManager } from './RoomManager';
import './style.css';
import './workspace.css';
import './theme.css';

const meta = {
  title: 'AudioShare/Room access',
  component: RoomManager,
  args: { base: 'http://127.0.0.1:18787', session: null, active: true, onSelect: fn(), onLogout: fn() },
  decorators: [Story => <div className="room-shell" style={{ padding: 24 }}><Story /></div>],
} satisfies Meta<typeof RoomManager>;
export default meta;
type Story = StoryObj<typeof meta>;

// No authenticated session: this state makes no network requests.
export const Unauthenticated: Story = {};
