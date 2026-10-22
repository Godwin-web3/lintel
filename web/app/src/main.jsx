import { createRoot } from 'react-dom/client';
import { legacyRedirect } from './site.jsx';
import Root from './Root.jsx';
import '../../../brand/tokens.css'; // brand kit: single source of color, type and spacing tokens
import './styles.css';

legacyRedirect(); // /#/listing/x (old links) -> /app#/listing/x, before the first render
createRoot(document.getElementById('root')).render(<Root />);
