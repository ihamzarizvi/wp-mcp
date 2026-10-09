<?php
/**
 * Plugin settings, stored in one option and editable under WP MCP > Settings.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_MCP_Bridge_Settings {
	const OPTION = 'wp_mcp_bridge_settings';

	/** Gated features and the wp-config.php constant that overrides each. */
	const FEATURES = array(
		'files' => 'WP_MCP_ALLOW_FILES',
		'db'    => 'WP_MCP_ALLOW_DB',
		'cli'   => 'WP_MCP_ALLOW_CLI',
	);

	public static function defaults() {
		return array(
			'enabled'        => true,
			'read_only'      => false,
			'allow_files'    => false,
			'allow_db'       => false,
			'allow_cli'      => false,
			'allowed_ips'    => '',
			'log_reads'      => false,
			'retention_days' => 30,
		);
	}

	public static function all() {
		return wp_parse_args( (array) get_option( self::OPTION, array() ), self::defaults() );
	}

	public static function get( $key ) {
		$all = self::all();
		return $all[ $key ];
	}

	/** A constant in wp-config.php always wins over the saved setting. */
	public static function feature_locked( $feature ) {
		return defined( self::FEATURES[ $feature ] );
	}

	public static function feature_enabled( $feature ) {
		$constant = self::FEATURES[ $feature ];
		if ( defined( $constant ) ) {
			return (bool) constant( $constant );
		}
		return (bool) self::get( 'allow_' . $feature );
	}

	public static function save( array $input ) {
		$clean = self::defaults();
		foreach ( array( 'enabled', 'read_only', 'allow_files', 'allow_db', 'allow_cli', 'log_reads' ) as $flag ) {
			$clean[ $flag ] = ! empty( $input[ $flag ] );
		}
		$ips   = preg_split( '/[\s,]+/', isset( $input['allowed_ips'] ) ? (string) $input['allowed_ips'] : '', -1, PREG_SPLIT_NO_EMPTY );
		$valid = array();
		foreach ( $ips as $ip ) {
			if ( false !== filter_var( $ip, FILTER_VALIDATE_IP ) ) {
				$valid[] = $ip;
			}
		}
		$clean['allowed_ips']    = implode( "\n", array_unique( $valid ) );
		$clean['retention_days'] = max( 1, min( 365, isset( $input['retention_days'] ) ? (int) $input['retention_days'] : 30 ) );
		update_option( self::OPTION, $clean, false );
		return $clean;
	}

	public static function client_ip() {
		return isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
	}

	public static function ip_allowed( $ip ) {
		$list = preg_split( '/\s+/', (string) self::get( 'allowed_ips' ), -1, PREG_SPLIT_NO_EMPTY );
		return empty( $list ) || in_array( $ip, $list, true );
	}

	/** Option names the REST option and SQL tools must never change. */
	public static function is_protected_option( $name ) {
		return 0 === strpos( (string) $name, 'wp_mcp_bridge_' );
	}
}
