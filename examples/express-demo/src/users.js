const users = new Map([["1", { profile: { name: "Ada" } }]]);

export function findUser(id) {
  const user = users.get(id);
  // Bug: missing users return undefined and the caller dereferences it.
  return normalize(user);
}

function normalize(user) {
  return user && { ...user, profile: { ...user.profile } };
}
