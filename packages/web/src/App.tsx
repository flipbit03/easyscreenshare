import Publisher from "./Publisher";
import Viewer from "./Viewer";

export default function App() {
  const match = location.pathname.match(/^\/s\/([A-Za-z0-9]{12})$/);
  return match ? <Viewer sessionId={match[1]} /> : <Publisher />;
}
