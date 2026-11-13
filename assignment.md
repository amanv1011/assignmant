Two-way sync
of customer and
contact records

Tequity builds software for clients. This is the exercise for our call on Friday 13 November 2026, 6:30 to 7:15 PM Indian Standard Time (IST). The call is on Google Meet: https://meet.google.com/zkb-ftve-een

Plan on about 4 hours. Most of that time is the design.

Send the deliverables on the calendar thread by 12:00 PM IST on Friday, so we can open them before the call.

Where this note is silent, write the assumption and the question you would have asked. We will read that list.

Background and scenario
A client runs its sales team in Salesforce, a customer relationship management (CRM) product. Tequity has built the client an operations portal. Finance and customer-success staff work in the portal.

The same people exist in both places, as customers and as contacts. A sales person creates a customer in Salesforce. The portal should show that customer. A finance person on the portal then corrects the billing city. Salesforce should show the new city. Later, a sales person changes the phone number in Salesforce. The portal should show the new phone, and the city the finance person set should still be there.

The client also needs the history. They need to know who changed the phone, and who changed the city. The fact of an earlier edit stays on record after a later edit.

Salesforce stores its own copy. The portal stores its copy in PostgreSQL (Postgres). The two copies have to stay in sync. We are designing and building our side. Salesforce already exists, and it stays as it is.

The systems involved
Three parties matter.

Salesforce. The client's CRM. Sales users edit records here. Salesforce has its own database.
The portal. Our application. Finance and customer-success users edit records here. Our database is Postgres.
The network between them. Salesforce and the portal talk over the public internet, using Hypertext Transfer Protocol Secure (HTTPS). Each side keeps its own database. HTTPS is the only path between them.
Who calls whom:

When a record changes in Salesforce, Salesforce calls us. The call is a webhook: an HTTPS request to an endpoint we host. The webhook names the record and describes the change.
When a record changes in the portal, we call Salesforce. The call uses Salesforce's official record application programming interface (API): the create and update operations Salesforce already documents. The portal reaches Salesforce through that record API.
A sales user talks only to Salesforce. A portal user talks only to the portal. Neither user talks to the other system.
The rate limit below applies to the requests we send to Salesforce. Webhooks Salesforce sends to us sit outside that cap.

 Sales user                         Finance / customer-success user
     |                                          |
     | uses                                     | uses
     v                                          v
 Salesforce CRM                           Tequity portal
 (their app, their database)              (our app)
     |                                          |
     |                                          v
     |                                     Postgres
     |                                     (our database)
     |
     |   (A) Salesforce calls us
     |       HTTPS webhook
     +---------------------------------->  portal webhook endpoint
     |
     |   (B) We call Salesforce
     |       HTTPS record API
     <----------------------------------+  portal sync worker
           create or update record
The webhook endpoint and the sync worker are both ours. They can be one service or two. Say which you choose, and what crosses the boundary between them.

A webhook is a message. Our endpoint has to accept it, check it, and apply it before anything is stored. A call to the Salesforce record API is a request we initiate. Salesforce may accept it, reject it, or be unreachable.

Requirements and scale
Records:

Customers and contacts. About these fields, and no others, for this exercise: customer name, status, and owner; contact full name, phone, email, city, owner, and the customer they belong to.
5 million records in production, customers and contacts counted together.
Sync:

While both systems are up, a create or an update on either side is visible on the other side within 30 seconds. Thirty seconds is the worst case. Everyday sync should land sooner.
Both sides may create. Both sides may update.
The current value of a field is the one we can justify. The earlier values, who made them, and when, stay on record. Dropping that history counts as losing a change.
An update we send to Salesforce must not bounce back and forth forever.
Webhooks:

Salesforce may deliver the same webhook twice.
Salesforce may deliver webhooks in a different order from the order of the edits.
Each webhook carries at least the fields in the sample below. occurredAt is the time Salesforce gives the event.
The CRM API allows at most 100 requests per second. That is our cap on calls to Salesforce. We choose how far under the cap to run.

We left the peak edit rate open. State the rate you assume, in edits per second, and use it in the arithmetic.

Sample webhook. This is enough to start. You may add fields. Say why.

{
  "eventId": "evt_1001",
  "recordId": "0031A00000Abc",
  "objectType": "Contact",
  "occurredAt": "2026-11-02T11:30:04.000Z",
  "changedBy": "sales.user@client.example",
  "changedFields": {
    "phone": "+919876543210"
  }
}
Sample portal edit. A finance user saved the form. The sample has no time field. Decide where the time and the actor come from, and write that down.

{
  "recordId": "0031A00000Abc",
  "objectType": "Contact",
  "editedBy": "finance.user@client.example",
  "changedFields": {
    "city": "Noida"
  }
}
Say whether you assume a webhook carries only the changed fields, or the full record. Pick one in the design. Say what your rule does in the other case.

Constraints
Rate limit. At most 100 requests per second to the Salesforce record API. The cap counts the calls we make, including retries. Webhooks arriving at our endpoint sit outside this cap. If Salesforce tells us to slow down, we slow down, and we keep the work.

Outages. Design for the Salesforce API being unreachable for 6 hours. Webhooks Salesforce tried to send during that window may never arrive. Pending calls to Salesforce must still be there after our own process restarts.

Thirty seconds applies while both systems are up. Catch-up after an outage is a different target. Drain the backlog as fast as the rate limit allows. Compute how long that takes, in minutes, for the edit rate you assumed. Show the division.

Consistency. Two people may edit the same record at the same time, on the same side or on opposite sides. Edits to different fields of that record both have to survive. Edits to the same field need one current value and a kept history.

Say what you use to decide which edit is current, on a webhook and on a portal save. Name the field. If you need an API this note does not give you, mark it as an assumption.

Out of scope for this weekend: deletes, Salesforce login screens, a visual user interface, a second region, and a load test against real Salesforce. If you write a program, call a fake CRM you write yourself.

What you deliver
Three things are required. A program is optional.

We ask for the chats and the commits because we want to see how you prompt the artificial intelligence (AI) assistant, and how your thinking develops. The final document alone does not show that.

1. The design document
This is the main piece, a few pages, long enough for the rules and the arithmetic. Write it so a teammate who was not on the call can build from it.

These four have to be in it, with a rule for each:

a duplicate webhook
a change that arrives out of order
a sync loop, where our own update comes back
the 6-hour Salesforce outage, including the minutes of arithmetic
Use this outline:

Assumptions, and the questions you would ask before you lock the design.
The systems, who calls whom, the network boundary, and the interface on each side.
The subproblems, in the order you would build them. Name the subproblems first. Add a component only when a subproblem needs it.
The data you store.
The inbound path, from webhook to our database.
The outbound path, from a portal edit to a Salesforce API call.
The rule when both sides change the same record.
The rule for a duplicate webhook, and for an older webhook that arrives after a newer one.
The rule that stops a loop.
The 6-hour outage: what is on disk, how you drain it, and the minutes of arithmetic.
Three numbers you would watch, and the value at which you would call someone.
What you are leaving out of this weekend's work.
2. Your full AI chat history, unedited
Include every chat you used for this task, every prompt, and every reply.

Do not clean the chats up, trim them, or rewrite them. Leave the wrong turns in. We will read them as they happened.

A single prompt that says "build the sync", followed by an answer you did not question, is a weak submission.

3. Your git repository, with every commit
Send the repository. Keep every commit and its message. Do not squash the work into one commit.

A message that says what you decided is useful. One commit called "final" is not useful.

4. Code, if you have time
Code is optional. Node.js is welcome if you want to check a rule. It is not required, and we will not treat a missing program as a gap.

If you build it, use TypeScript on Node.js, version 20 or newer. It has to run with Node.js alone. Fake Salesforce. One command should run a demo from a fresh checkout. npm install plus that command is the upper bound.

The useful checks are the same four rules: a duplicate, an older event after a newer one, a webhook that must not be sent back to Salesforce, and a pending call that is still there after a restart while the fake Salesforce is down. The cap in the design is 100 requests per second. In a demo you may set a lower cap so the wait is visible. The code must enforce the cap it is given.

A service we would ship is out of scope.

What we will evaluate
We are looking at three things.

How you break the problem into subproblems. The order should show which part is risky, and why you take that part before the rest.
How you design the system and its components. The systems, the caller on each path, the network boundary, and the interface on each side should be explicit. The rules for the 6-hour outage, duplicates, out-of-order changes, and sync loops should be specific, and the numbers should close.
How you prompt an AI assistant, and how your thinking develops. The chats and the commits should show the path from the first question to the final design. You should be able to point at a place you pushed back.
If you bring code, we will check that it matches the design. A rule that is only in the document, and a demo that does something else, will come up on the call. Bringing no code will not come up on the call.

What to bring to the call
A 10-minute walkthrough. Start with the assumptions and the questions that are still open. Then the diagram: who calls whom. Then the rules for conflict, order, loops, and the outage. Then the arithmetic. We will stop you at 10 minutes and ask questions.
The open questions. Bring the list you would have asked before starting, including the ones you closed with an assumption. For each assumption, one sentence on what would change if the answer went the other way.
The chats and the commits. Have them sent before the call. We will open a prompt and a commit and ask what you changed after.
A running demo, only if you built the code. Have it started before 6:30 PM IST. We may ask you to change one input and run it again. A duplicate, an older event after a newer one, and a restart with the fake CRM down are the likely changes. If you did not write a program, skip this.
The call is 45 minutes. The walkthrough is 10 of those minutes. The rest is questions. A demo, if you have one, fits inside that time.

Assumptions and questions
Put this section at the top of your design document. These are silent in the brief, so they need an assumption or a question:

How many edits per second happen at peak, and how many in a quiet hour?
Does a webhook carry changed fields only, or the whole record?
Can we ask Salesforce for records that changed during the 6 hours, or are those changes gone unless we already have them?
When two portal users edit the same field, what does the other user see, and what do we send Salesforce?
What do we trust for order on a portal edit, given that the sample has no time field?
Add any other question that would change the design. A question you do not have time to answer is still worth writing down.

Two-way sync of customer and contact records