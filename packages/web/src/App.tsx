import Publisher from "./Publisher";
import Viewer from "./Viewer";

export default function App() {
  // Session ids: random 12-char, or vanity names (3–32, matching the server).
  const match = location.pathname.match(/^\/s\/([A-Za-z0-9_-]{3,32})$/);
  return match ? <Viewer sessionId={match[1]} /> : <Publisher />;
}
