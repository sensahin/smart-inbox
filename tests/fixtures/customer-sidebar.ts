const environment = (
  plugin: string,
) => `<li><div><h4><i></i><b>Environment</b></h4><ul>
<li><span>Plugin Version <span>${plugin}</span></span></li><li><span>PHP Version <span>8.3.33</span></span></li><li><span>WordPress Version <span>7.1</span></span></li><li><span>SDK Version <span>2.13.4</span></span></li><li><span>Language <span>en-US</span></span></li></ul></div></li>`;
const site = (
  id: number,
  title: string,
  status: string,
  edition = "Premium Version",
) => `<div><h4><a href="#"><i></i></a><a href="https://dashboard.freemius.com/#!/live/products/12345/sites/${id}/"><span>${title} (${id})</span></a></h4><div><ul>
<li><h4><i></i><b><a href="https://${title.toLowerCase().replaceAll(" ", "-")}.example.test">${title.toLowerCase().replaceAll(" ", "-")}.example.test</a></b></h4></li>
<li><h4>LTV: <span>$95.88</span></h4></li><li><h4><span>${edition}</span></h4></li>
<li><div><h4><b>${edition === "Free Version" ? "Free Plan" : "Professional Plan"}</b></h4><ul><li><h4>License: <span>${status}</span></h4></li></ul></div></li>${environment("2.4.78")}</ul></div></div>`;
export const callbackFixture = `<div><h4><i></i><b><a href="https://dashboard.freemius.com/#!/live/products/12345/users/123/">Elena Martin Profile (123)</a></b></h4><div>
<div><h4>LTV: $191.76</h4></div><div><h4><a href="mailto:elena@example.test">elena@example.test</a></h4></div><div><h4>Joined: Mar 23, 2026 GMT</h4></div><div><h4><a href="https://dashboard.freemius.com/review/12345/example">Review link</a></h4></div></div></div><div>
${site(100, "Customer website", "Active")}${site(101, "Staging", "Active (lifetime)")}${site(102, "Previous site", "Expired")}${site(103, "Workshop", "Trial")}${site(104, "Demo", "Inactive")}${site(105, "Community", "Inactive", "Free Version")}</div>`;
export const structuredFixture = {
  user: {
    id: 124,
    first: "Jordan",
    last: "Smith",
    email: "jordan.smith@example.test",
    created: "2026-03-23 12:00:00",
    gross: 95.88,
  },
  entitlement: "Active paid",
  profile_url:
    "https://dashboard.freemius.com/#!/live/products/12345/users/124/",
  plans: [{ id: 19820, title: "Professional", name: "pro" }],
  licenses: [
    {
      id: 888,
      plan_id: 19820,
      expiration: null,
      is_trial: false,
      is_cancelled: false,
      quota: 3,
      activated: 2,
    },
    {
      id: 889,
      plan_id: 19820,
      expiration: "2020-01-01 00:00:00",
      is_trial: false,
      is_cancelled: false,
      quota: 1,
      activated: 0,
    },
  ],
  subscriptions: [
    {
      id: 777,
      plan_id: 19820,
      is_active: false,
      canceled_at: "2026-09-01 00:00:00",
      billing_cycle: "Annual",
      amount: 95.88,
      currency: "USD",
      next_payment: null,
    },
  ],
  installs: [
    {
      id: 222,
      url: "https://jordan.example.test",
      version: "2.4.78",
      php_version: "8.3.33",
      platform_version: "7.1",
      is_active: true,
      license_id: 888,
    },
  ],
  payments: [
    {
      id: 555,
      created: "2026-03-23 12:00:00",
      amount: 95.88,
      currency: "USD",
      is_refunded: false,
    },
    {
      id: 556,
      created: "2026-04-23 12:00:00",
      amount: 9.99,
      currency: "USD",
      is_refunded: true,
    },
  ],
};
export const sidebarFixtures = {
  "demo-elena": {
    freemius: { state: "matched", html: callbackFixture },
    mailchimp: {
      state: "matched",
      data: {
        members: [
          {
            id: "member",
            list_id: "audience",
            list_name: "Northstar newsletter",
            status: "subscribed",
            tags: [{ id: 1, name: "Plugin customer" }],
            profile_url:
              "https://us10.admin.mailchimp.com/lists/members/view?id=123",
          },
        ],
      },
    },
  },
  "demo-david": {
    freemius: { state: "not_found" },
    mailchimp: {
      state: "not_found",
      data: {
        audiences: [{ id: "audience", name: "Northstar newsletter" }],
      },
    },
  },
  "demo-sophia": {
    freemius: { state: "error", error: "Provider credentials were rejected." },
    mailchimp: {
      state: "error",
      error: "Provider is temporarily unavailable. Try again.",
    },
  },
  "demo-jordan": {
    freemius: { state: "matched", data: structuredFixture },
    mailchimp: {
      state: "matched",
      data: {
        members: [
          {
            id: "member2",
            list_id: "audience",
            list_name: "Northstar newsletter",
            status: "unsubscribed",
            tags: [],
            profile_url:
              "https://us10.admin.mailchimp.com/lists/members/view?id=124",
          },
        ],
      },
    },
  },
};
