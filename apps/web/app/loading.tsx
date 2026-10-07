export default function Loading() {
  return (
    <main className="shell">
      <div className="page-loading route-loading" aria-live="polite" aria-busy="true">
        <div className="route-loading-mark" aria-hidden="true">T</div>
      </div>
    </main>
  );
}
