import type { Route } from "next";
import Link from "next/link";

const links: Array<{ href: Route; label: string }> = [
  { href: "/inbox", label: "Inbox" },
  { href: "/planner-runs", label: "Planner Runs" },
  { href: "/schedule", label: "Schedule" },
  { href: "/settings", label: "Settings" },
];

export default function HomePage() {
  return (
    <main style={{ padding: "3rem", maxWidth: "70rem", margin: "0 auto" }}>
      <h1 style={{ fontSize: "3rem", marginBottom: "1rem" }}>Atlas Admin</h1>
      <p style={{ maxWidth: "40rem", lineHeight: 1.6 }}>
        The messaging bot is the product surface. This interface exists for
        operators, debugging, and schedule inspection.
      </p>
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
          gap: "1rem",
          marginTop: "2rem",
        }}
      >
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            style={{
              padding: "1rem",
              textDecoration: "none",
              background: "#fffdf7",
              border: "1px solid #c6bca1",
              color: "#1f2a1f",
            }}
          >
            {link.label}
          </Link>
        ))}
      </section>
    </main>
  );
}
