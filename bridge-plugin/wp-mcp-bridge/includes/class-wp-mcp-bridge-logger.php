<?php
/**
 * Activity log: one row per REST request made by the wp-mcp server.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_MCP_Bridge_Logger {
	const DB_VERSION        = '1';
	const DB_VERSION_OPTION = 'wp_mcp_bridge_db_version';
	const MAX_PARAM_CHARS   = 2000;
	const MAX_VALUE_CHARS   = 200;

	private static $started  = 0.0;
	private static $app_name = '';

	public static function init() {
		add_action( 'plugins_loaded', array( __CLASS__, 'maybe_install' ) );
		add_action( 'application_password_did_authenticate', array( __CLASS__, 'remember_app_password' ), 10, 2 );
		add_filter( 'rest_pre_dispatch', array( __CLASS__, 'start_timer' ), 0, 3 );
		add_filter( 'rest_post_dispatch', array( __CLASS__, 'record' ), 999, 3 );
	}

	public static function table() {
		global $wpdb;
		return $wpdb->prefix . 'wp_mcp_log';
	}

	/** Runs on activation and after an update that was uploaded over the old copy. */
	public static function maybe_install() {
		if ( get_option( self::DB_VERSION_OPTION ) === self::DB_VERSION ) {
			return;
		}
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();
		dbDelta(
			"CREATE TABLE $table (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			created_at datetime NOT NULL,
			user_id bigint(20) unsigned NOT NULL DEFAULT 0,
			app_name varchar(190) NOT NULL DEFAULT '',
			method varchar(10) NOT NULL DEFAULT '',
			route varchar(255) NOT NULL DEFAULT '',
			status smallint(5) unsigned NOT NULL DEFAULT 0,
			error_code varchar(100) NOT NULL DEFAULT '',
			duration_ms int(10) unsigned NOT NULL DEFAULT 0,
			ip varchar(45) NOT NULL DEFAULT '',
			params text NULL,
			PRIMARY KEY  (id),
			KEY created_at (created_at)
			) $charset;"
		);
		update_option( self::DB_VERSION_OPTION, self::DB_VERSION, false );
	}

	public static function remember_app_password( $user, $item ) {
		self::$app_name = isset( $item['name'] ) ? (string) $item['name'] : '';
	}

	public static function start_timer( $result, $server, $request ) {
		if ( WP_MCP_Bridge::is_mcp_request( $request ) ) {
			self::$started = microtime( true );
		}
		return $result;
	}

	private static function redact( $value, $key = '' ) {
		if ( preg_match( '/pass|secret|token|auth|api[_-]?key/i', (string) $key ) ) {
			return '[redacted]';
		}
		if ( is_array( $value ) ) {
			$out = array();
			foreach ( $value as $k => $v ) {
				$out[ $k ] = self::redact( $v, $k );
			}
			return $out;
		}
		if ( is_string( $value ) && strlen( $value ) > self::MAX_VALUE_CHARS ) {
			return substr( $value, 0, self::MAX_VALUE_CHARS ) . '... (' . strlen( $value ) . ' chars)';
		}
		return $value;
	}

	private static function summarise( WP_REST_Request $request ) {
		$json   = $request->get_json_params();
		$params = array_merge( (array) $request->get_query_params(), is_array( $json ) ? $json : (array) $request->get_body_params() );
		if ( empty( $params ) ) {
			return '';
		}
		$text = wp_json_encode( self::redact( $params ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE );
		if ( ! is_string( $text ) ) {
			return '';
		}
		return strlen( $text ) > self::MAX_PARAM_CHARS ? substr( $text, 0, self::MAX_PARAM_CHARS ) . '...' : $text;
	}

	public static function record( $response, $server, $request ) {
		if ( ! WP_MCP_Bridge::is_mcp_request( $request ) ) {
			return $response;
		}
		$method = $request->get_method();
		if ( in_array( $method, array( 'GET', 'HEAD', 'OPTIONS' ), true ) && ! WP_MCP_Bridge_Settings::get( 'log_reads' ) ) {
			return $response;
		}
		$status = $response instanceof WP_HTTP_Response ? (int) $response->get_status() : 0;
		$data   = $response instanceof WP_HTTP_Response ? $response->get_data() : null;
		$code   = $status >= 400 && is_array( $data ) && isset( $data['code'] ) ? (string) $data['code'] : '';

		global $wpdb;
		$wpdb->insert(
			self::table(),
			array(
				'created_at'  => current_time( 'mysql', true ),
				'user_id'     => get_current_user_id(),
				'app_name'    => substr( '' !== self::$app_name ? self::$app_name : WP_MCP_Bridge_Keys::used_name(), 0, 190 ),
				'method'      => $method,
				'route'       => substr( $request->get_route(), 0, 255 ),
				'status'      => $status,
				'error_code'  => substr( $code, 0, 100 ),
				'duration_ms' => self::$started ? (int) round( ( microtime( true ) - self::$started ) * 1000 ) : 0,
				'ip'          => WP_MCP_Bridge_Settings::client_ip(),
				'params'      => self::summarise( $request ),
			)
		);
		if ( 1 === wp_rand( 1, 50 ) ) {
			self::prune();
		}
		return $response;
	}

	public static function prune() {
		global $wpdb;
		$table  = self::table();
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - DAY_IN_SECONDS * (int) WP_MCP_Bridge_Settings::get( 'retention_days' ) );
		$wpdb->query( $wpdb->prepare( "DELETE FROM $table WHERE created_at < %s", $cutoff ) ); // phpcs:ignore WordPress.DB
	}

	public static function clear() {
		global $wpdb;
		$table = self::table();
		$wpdb->query( "DELETE FROM $table" ); // phpcs:ignore WordPress.DB
	}

	/**
	 * @param array $args kind (all|writes|errors), search, page, per_page.
	 * @return array{rows: array, total: int}
	 */
	public static function query( array $args ) {
		global $wpdb;
		$table    = self::table();
		$where    = array( '1=1' );
		$values   = array();
		$kind     = isset( $args['kind'] ) ? $args['kind'] : 'all';
		$per_page = max( 1, min( 200, isset( $args['per_page'] ) ? (int) $args['per_page'] : 50 ) );
		$page     = max( 1, isset( $args['page'] ) ? (int) $args['page'] : 1 );

		if ( 'writes' === $kind ) {
			$where[] = "method NOT IN ('GET','HEAD','OPTIONS')";
		} elseif ( 'errors' === $kind ) {
			$where[] = 'status >= 400';
		}
		if ( ! empty( $args['search'] ) ) {
			$like     = '%' . $wpdb->esc_like( (string) $args['search'] ) . '%';
			$where[]  = '(route LIKE %s OR params LIKE %s)';
			$values[] = $like;
			$values[] = $like;
		}
		$where_sql = implode( ' AND ', $where );

		$count_sql = "SELECT COUNT(*) FROM $table WHERE $where_sql";
		$total     = (int) $wpdb->get_var( $values ? $wpdb->prepare( $count_sql, $values ) : $count_sql ); // phpcs:ignore WordPress.DB

		$values[] = $per_page;
		$values[] = ( $page - 1 ) * $per_page;
		$rows     = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM $table WHERE $where_sql ORDER BY id DESC LIMIT %d OFFSET %d", $values ), ARRAY_A ); // phpcs:ignore WordPress.DB

		return array( 'rows' => (array) $rows, 'total' => $total );
	}

	/** Counts for the overview cards. */
	public static function stats() {
		global $wpdb;
		$table = self::table();
		$since = gmdate( 'Y-m-d H:i:s', time() - DAY_IN_SECONDS );
		return array(
			'last'   => $wpdb->get_var( "SELECT MAX(created_at) FROM $table" ), // phpcs:ignore WordPress.DB
			'day'    => (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM $table WHERE created_at >= %s", $since ) ), // phpcs:ignore WordPress.DB
			'errors' => (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM $table WHERE created_at >= %s AND status >= 400", $since ) ), // phpcs:ignore WordPress.DB
		);
	}
}
