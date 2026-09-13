# Reports

Open **Reports** in the sidebar. **Overview** shows conversation and email volume, incoming activity by weekday and hour, active customers, and an inbox breakdown. **Email performance** shows reply speed, resolutions, timing percentiles, and response time distribution.

Choose a date preset or custom dates, then select one inbox or all inboxes. Dates use the workspace time zone configured in Settings. The range is inclusive and supports up to 366 calendar days. Comparison uses the immediately preceding period with the same number of calendar days. A range including today contains a partial day; the comparison period contains complete days.

Click a metric to inspect its conversations. Select a conversation to open it or a customer to see their contact history. **Refresh** updates the report; reports do not continuously recalculate in the background.

## Metrics

| Metric | Calculation |
| --- | --- |
| Active conversations | Distinct conversations created, emailed, or changed status during the period. |
| New conversations | Conversations created during the period, including conversations you started. |
| Messages received | Incoming messages received during the period. Multiple messages in a conversation count separately. |
| Emails sent | Accepted outgoing messages during the period, including new emails and forwards. |
| Customers | Distinct contacts with incoming messages during the period. |
| Customers helped | Distinct contacts receiving a reply during the period. New emails and forwards are excluded. |
| First response time | Time from the first incoming message to the first reply, when that first reply was sent during the period. Conversations started by you and conversations with incomplete history are excluded. |
| Response time | Time from the earliest unanswered incoming message to your next reply, when that reply was sent during the period. Consecutive customer messages share one timer; consecutive outgoing replies do not create new timers. |
| Resolved | Currently closed conversations whose latest recorded closure falls within the period and that have at least one reply to the customer before closure. |
| Resolution time | Time from conversation creation to its latest recorded closure for resolved conversations in the period. Incomplete history is excluded. |
| Resolved with one reply | Percentage of resolved conversations with complete history and exactly one reply to the customer before closure. |
| Open now / Waiting now | Current conversation counts in the selected inboxes, regardless of the report dates. |

Automatic acknowledgements, unsent drafts, and conversations in Trash are excluded. Failed, pending, and uncertain sends do not count as sent until Gmail acceptance has been recorded. Messages sent directly in Gmail can appear once synchronized. Forwards and emails addressed only to someone other than the conversation's customer do not stop reply timers. Automated incoming provider notifications remain part of email volume.

All durations use elapsed time, including nights and weekends. Average is the arithmetic mean, median is the middle sample, and the 90th percentile is the duration at or below which 90% of samples fall. A dash means there is no eligible timing sample; it does not mean zero. Charts include days without activity.

Resolution tracking begins when the reporting migration is applied. Existing closed tickets without a recorded closure have no resolution timestamp; the report displays its coverage date. Status changes are recorded atomically for manual actions, bulk actions, accepted sends, incoming replies, and bounces. A reopened conversation leaves resolution metrics until it is closed again. Its latest closure determines the period where it is counted, so past reports can change as conversations reopen, close, or move to Trash.

## CSV exports

At the bottom of the report, choose **Daily metrics** or **Selected conversation metric**, then **Export CSV**. Conversation exports include every matching row, including rows beyond the displayed page. Daily exports include sample counts and the closure tracking start date. Durations are exported in seconds. Calendar dates use the workspace time zone; individual closure timestamps are explicitly UTC.

Exports require the same owner authentication as the dashboard, are not publicly cached, and contain customer information. Spreadsheet formula prefixes are escaped. Keep downloaded reports private.

The report reads message metadata without fetching bodies or calling customer integrations or AI. Very large reports are rejected with a request to narrow the period or inbox, rather than returning silently truncated totals. Each calculation is bounded at 10,000 conversations, 100,000 associated messages, and 50,000 status changes across the selected and comparison periods. A long conversation's earlier messages may also be needed to calculate its reply timers accurately.
