<?php
/**
 * Connection keys: the plugin's own REST login, for sites where WordPress
 * Application Passwords are disabled or the host strips the Authorization header.
 *
 * A key is sent in the X-WP-MCP-Key header and logs the request in as the
 * administrator who created it. Only a SHA-256 hash of each key is stored.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_MCP_Bridge_Keys {
	const OPTION = 'wp_mcp_bridge_keys';

	private static $error     = null;
	private static $used_name = '';

	public static function init() {
		add_filter( 'determine_current_user', array( __CLASS__, 'authenticate' ), 20 );
		add_filter( 'rest_authentication_errors', array( __CLASS__, 'authentication_error' ), 20 );
	}

	public static function all() {
		$keys = get_option( self::OPTION, array() );
		return is_array( $keys ) ? $keys : array();
	}

	/** Creates a key and returns it. This is the only time the key itself exists on the site. */
	public static function create( $user_id, $name ) {
		$id          = strtolower( wp_generate_password( 8, false ) );
		$key         = 'wpmcp_' . $id . '_' . wp_generate_password( 40, false );
		$keys        = self::all();
		$keys[ $id ] = array(
			'name'      => '' !== $name ? $name : 'wp-mcp',
			'user_id'   => (int) $user_id,
			'hash'      => hash( 'sha256', $key ),
			'created'   => time(),
			'last_used' => 0,
			'last_ip'   => '',
		);
		update_option( self::OPTION, $keys, false );
		return $key;
	}

	public static function revoke( $id ) {
		$keys = self::all();
		if ( ! isset( $keys[ $id ] ) ) {
			return false;
		}
		unset( $keys[ $id ] );
		update_option( self::OPTION, $keys, false );
		return true;
	}

	private static function presented_key() {
		return isset( $_SERVER['HTTP_X_WP_MCP_KEY'] ) ? trim( (string) wp_unslash( $_SERVER['HTTP_X_WP_MCP_KEY'] ) ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	}

	public static function presented() {
		return '' !== self::presented_key();
	}

	/** Name of the key that authenticated this request, for the activity log. */
	public static function used_name() {
		return self::$used_name;
	}

	/**
	 * REST_REQUEST is not defined yet if something asks for the current user
	 * early, so the request is recognised from its URL instead.
	 */
	private static function is_rest_request() {
		if ( isset( $_GET['rest_route'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification
			return true;
		}
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		return false !== strpos( $uri, '/' . rest_get_url_prefix() . '/' );
	}

	public static function authenticate( $user_id ) {
		if ( ! empty( $user_id ) ) {
			return $user_id;
		}
		$key = self::presented_key();
		if ( '' === $key || ! self::is_rest_request() ) {
			return $user_id;
		}

		$parts = explode( '_', $key, 3 );
		$keys  = self::all();
		$id    = 3 === count( $parts ) && 'wpmcp' === $parts[0] ? $parts[1] : '';
		if ( '' === $id || ! isset( $keys[ $id ] ) || ! hash_equals( $keys[ $id ]['hash'], hash( 'sha256', $key ) ) ) {
			self::$error = new WP_Error( 'wp_mcp_invalid_key', 'The connection key is not valid for this site. It may have been revoked; create a new one under WP Admin > WP MCP.', array( 'status' => 401 ) );
			return $user_id;
		}

		$record = $keys[ $id ];
		if ( ! user_can( (int) $record['user_id'], 'manage_options' ) ) {
			self::$error = new WP_Error( 'wp_mcp_invalid_key', 'The user this connection key belongs to is no longer an administrator.', array( 'status' => 401 ) );
			return $user_id;
		}

		self::$used_name = (string) $record['name'];
		// One write every few minutes is enough to show the key is in use.
		if ( time() - (int) $record['last_used'] > 5 * MINUTE_IN_SECONDS ) {
			$keys[ $id ]['last_used'] = time();
			$keys[ $id ]['last_ip']   = WP_MCP_Bridge_Settings::client_ip();
			update_option( self::OPTION, $keys, false );
		}
		return (int) $record['user_id'];
	}

	public static function authentication_error( $result ) {
		if ( ! empty( $result ) ) {
			return $result;
		}
		return self::$error ? self::$error : $result;
	}
}
