import * as channel from "./channel";
import * as message_flags from "./message_flags";
import * as message_list from "./message_list";
import * as message_lists from "./message_lists";
import * as message_live_update from "./message_live_update";
import * as message_store from "./message_store";
import * as message_viewport from "./message_viewport";
import * as notifications from "./notifications";
import * as people from "./people";
import * as recent_topics_ui from "./recent_topics_ui";
import * as recent_topics_util from "./recent_topics_util";
import * as reload from "./reload";
import * as unread from "./unread";
import * as unread_ui from "./unread_ui";

export function mark_all_as_read() {
    unread.declare_bankruptcy();
    unread_ui.update_unread_counts();

    channel.post({
        url: "/json/mark_all_as_read",
        success: () => {
            // After marking all messages as read, we reload the browser.
            // This is useful to avoid leaving ourselves deep in the past.
            reload.initiate({
                immediate: true,
                save_pointer: false,
                save_narrow: true,
                save_compose: true,
            });
        },
    });
}

function process_newly_read_message(message, options) {
    for (const msg_list of message_lists.all_rendered_message_lists()) {
        msg_list.show_message_as_read(message, options);
    }
    notifications.close_notification(message);
    recent_topics_ui.update_topic_unread_count(message);
}

export function mark_as_unread_from_here(message_id) {
    /* TODO: This algorithm is not correct if we don't have full data for
       the current narrow loaded from the server.

       Currently, we turn off the feature when fetch_status suggests
       we are in that that situation, but we plan to replace this
       logic with asking the server to do the marking as unread.
     */
    const message_ids = message_lists.current.ids_greater_or_equal_than(message_id);
    message_lists.current.prevent_reading();
    message_flags.mark_as_unread(message_ids);
}

export function resume_reading() {
    message_lists.current.resume_reading();
}

export function process_read_messages_event(message_ids) {
    /*
        This code has a lot in common with notify_server_messages_read,
        but there are subtle differences due to the fact that the
        server can tell us about unread messages that we didn't
        actually read locally (and which we may not have even
        loaded locally).
    */
    const options = {from: "server"};

    message_ids = unread.get_unread_message_ids(message_ids);
    if (message_ids.length === 0) {
        return;
    }

    for (const message_id of message_ids) {
        if (message_lists.current === message_list.narrowed) {
            // I'm not sure this entirely makes sense for all server
            // notifications.
            unread.set_messages_read_in_narrow(true);
        }

        unread.mark_as_read(message_id);

        const message = message_store.get(message_id);

        if (message) {
            process_newly_read_message(message, options);
        }
    }

    unread_ui.update_unread_counts();
}

export function process_unread_messages_event({message_ids, message_details}) {
    // This is the reverse of  process_unread_messages_event.
    message_ids = unread.get_read_message_ids(message_ids);
    if (message_ids.length === 0) {
        return;
    }

    if (message_lists.current === message_list.narrowed) {
        unread.set_messages_read_in_narrow(false);
    }

    for (const message_id of message_ids) {
        const message = message_store.get(message_id);

        if (message) {
            message.unread = true;
        }

        const message_info = message_details[message_id];

        let user_ids_string;

        if (message_info.type === "private") {
            user_ids_string = people.pm_lookup_key_from_user_ids(message_info.user_ids);
        }

        unread.process_unread_message({
            id: message_id,
            mentioned: message_info.mentioned,
            stream_id: message_info.stream_id,
            topic: message_info.topic,
            type: message_info.type,
            unread: true,
            user_ids_string,
        });

        if (message_info.type === "stream") {
            // TODO: Rather than passing a fake partial message, we
            // should probably define a proper type for unread message
            // data where we don't have the full message object, that
            // we can use both in this function and pass to recent
            // topics here.
            recent_topics_ui.update_topic_unread_count({
                stream_id: message_info.stream_id,
                topic: message_info.topic,
                type: message_info.type,
            });
        }
    }

    /*
        We use a big-hammer approach now to updating the message view.
        This is relatively harmless, since the only time we are called is
        when the user herself marks her message as unread.  But we
        do eventually want to be more surgical here, especially once we
        have a final scheme for how best to structure the HTML within
        the message to indicate read-vs.-unread.  Currently we use a
        green border, but that may change.
    */
    message_live_update.rerender_messages_view();

    unread_ui.update_unread_counts();
}

// Takes a list of messages and marks them as read.
// Skips any messages that are already marked as read.
export function notify_server_messages_read(messages, options = {}) {
    messages = unread.get_unread_messages(messages);
    if (messages.length === 0) {
        return;
    }

    message_flags.send_read(messages);

    for (const message of messages) {
        if (message_lists.current === message_list.narrowed) {
            unread.set_messages_read_in_narrow(true);
        }

        unread.mark_as_read(message.id);
        process_newly_read_message(message, options);
    }

    unread_ui.update_unread_counts();
}

export function notify_server_message_read(message, options) {
    notify_server_messages_read([message], options);
}

export function process_scrolled_to_bottom() {
    if (recent_topics_util.is_visible()) {
        // First, verify the current message list is visible.
        return;
    }

    if (message_lists.current.can_mark_messages_read()) {
        mark_current_list_as_read();
        return;
    }

    // For message lists that don't support marking messages as read
    // automatically, we display a banner offering to let you mark
    // them as read manually, only if there are unreads present.
    if (message_lists.current.has_unread_messages()) {
        unread_ui.notify_messages_remain_unread();
    }
}

// If we ever materially change the algorithm for this function, we
// may need to update notifications.received_messages as well.
export function process_visible() {
    if (message_viewport.is_visible_and_focused() && message_viewport.bottom_message_visible()) {
        process_scrolled_to_bottom();
    }
}

export function mark_current_list_as_read(options) {
    notify_server_messages_read(message_lists.current.all_messages(), options);
}

export function mark_stream_as_read(stream_id, cont) {
    channel.post({
        url: "/json/mark_stream_as_read",
        data: {stream_id},
        success: cont,
    });
}

export function mark_topic_as_read(stream_id, topic, cont) {
    channel.post({
        url: "/json/mark_topic_as_read",
        data: {stream_id, topic_name: topic},
        success: cont,
    });
}

export function mark_pm_as_read(user_ids_string) {
    // user_ids_string is a stringified list of user ids which are
    // participants in the conversation other than the current
    // user. Eg: "123,124" or "123"
    const unread_msg_ids = unread.get_msg_ids_for_user_ids_string(user_ids_string);
    message_flags.mark_as_read(unread_msg_ids);
}
