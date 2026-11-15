import type { Preview } from '@storybook/react-vite';
import '../src/components.css';
import '../src/meeting/style.css';
import '../src/meeting/workspace.css';
import '../src/meeting/theme.css';
import '../src/meeting/meeting.css';
import '../src/meeting/meeting-polish.css';

const preview: Preview = { parameters: { layout: 'fullscreen' } };
export default preview;
