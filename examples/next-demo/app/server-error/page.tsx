export const dynamic = "force-dynamic";

async function loadProfile(id: string): Promise<{ name: string }> {
  const res = await Promise.resolve(null as { name: string } | null);
  if (!res) throw new Error(`Profile ${id} not found in upstream service`);
  return res;
}

export default async function ServerErrorPage() {
  const profile = await loadProfile("u_123");
  return <p>Hello {profile.name}</p>;
}
