<?php
// Removes everything the plugin stored when it is deleted from the Plugins screen.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;
$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}wp_mcp_log" ); // phpcs:ignore WordPress.DB
delete_option( 'wp_mcp_bridge_settings' );
delete_option( 'wp_mcp_bridge_db_version' );
