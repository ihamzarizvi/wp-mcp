<?php
/**
 * Plugin Name: WP MCP Bridge
 * Description: Adds the admin REST endpoints the wp-mcp server needs beyond core REST: themes, plugin updates, options, post meta, Elementor, cron, cache, and (off by default) file, database and WP-CLI access.
 * Version: 0.1.0
 * Author: Hamza Rizvi
 * Author URI: https://hamzarizvi.com
 * Requires at least: 5.6
 * Requires PHP: 7.4
 *
 * Every route requires an administrator (manage_options). The three powerful
 * features are disabled until switched on in wp-config.php:
 *
 *   define( 'WP_MCP_ALLOW_FILES', true ); // read/write files under wp-content
 *   define( 'WP_MCP_ALLOW_DB', true );    // run SQL
 *   define( 'WP_MCP_ALLOW_CLI', true );   // run WP-CLI (needs proc_open and a wp binary)
 *   define( 'WP_MCP_CLI_PATH', '/usr/local/bin/wp' ); // optional, default "wp"
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_MCP_Bridge {
	const VERSION        = '0.1.0';
	const NS             = 'wp-mcp/v1';
	const MAX_FILE_BYTES = 2097152;
	const MAX_DB_ROWS    = 1000;
	const CLI_TIMEOUT    = 120;

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function can_manage() {
		return current_user_can( 'manage_options' );
	}

	private static function route( $path, $methods, $callback ) {
		register_rest_route(
			self::NS,
			$path,
			array(
				'methods'             => $methods,
				'callback'            => array( __CLASS__, $callback ),
				'permission_callback' => array( __CLASS__, 'can_manage' ),
			)
		);
	}

	public static function register_routes() {
		self::route( '/status', 'GET', 'status' );
		self::route( '/plugins/update', 'POST', 'plugin_update' );
		self::route( '/themes/install', 'POST', 'theme_install' );
		self::route( '/themes/activate', 'POST', 'theme_activate' );
		self::route( '/themes/update', 'POST', 'theme_update' );
		self::route( '/themes/(?P<stylesheet>[\w.-]+)', 'DELETE', 'theme_delete' );
		self::route( '/options', 'GET', 'options_get' );
		self::route( '/options', 'POST', 'option_set' );
		self::route( '/options', 'DELETE', 'option_delete' );
		self::route( '/postmeta/(?P<id>\d+)', 'GET', 'postmeta_get' );
		self::route( '/postmeta/(?P<id>\d+)', 'POST', 'postmeta_set' );
		self::route( '/postmeta/(?P<id>\d+)', 'DELETE', 'postmeta_delete' );
		self::route( '/elementor/(?P<id>\d+)', 'GET', 'elementor_get' );
		self::route( '/elementor/(?P<id>\d+)', 'POST', 'elementor_set' );
		self::route( '/cron', 'GET', 'cron_list' );
		self::route( '/cron/run', 'POST', 'cron_run' );
		self::route( '/cache/flush', 'POST', 'cache_flush' );
		self::route( '/files', 'GET', 'file_get' );
		self::route( '/files', 'POST', 'file_write' );
		self::route( '/db/query', 'POST', 'db_query' );
		self::route( '/cli', 'POST', 'cli' );
	}

	private static function enabled( $constant ) {
		return defined( $constant ) && constant( $constant );
	}

	private static function gate( $constant ) {
		if ( self::enabled( $constant ) ) {
			return true;
		}
		return new WP_Error(
			'wp_mcp_disabled',
			sprintf( "This feature is disabled on this site. To enable it, add define( '%s', true ); to wp-config.php.", $constant ),
			array( 'status' => 403 )
		);
	}

	private static function error( $code, $message, $status = 400 ) {
		return new WP_Error( $code, $message, array( 'status' => $status ) );
	}

	/* ---------------------------------------------------------------- status */

	public static function status() {
		$plugin_updates = get_site_transient( 'update_plugins' );
		$theme_updates  = get_site_transient( 'update_themes' );
		return array(
			'bridge_version'  => self::VERSION,
			'wp_version'      => get_bloginfo( 'version' ),
			'php_version'     => PHP_VERSION,
			'multisite'       => is_multisite(),
			'home'            => home_url(),
			'active_theme'    => get_stylesheet(),
			'active_plugins'  => count( (array) get_option( 'active_plugins', array() ) ),
			'woocommerce'     => defined( 'WC_VERSION' ) ? WC_VERSION : null,
			'elementor'       => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null,
			'features'        => array(
				'files' => self::enabled( 'WP_MCP_ALLOW_FILES' ),
				'db'    => self::enabled( 'WP_MCP_ALLOW_DB' ),
				'cli'   => self::enabled( 'WP_MCP_ALLOW_CLI' ),
			),
			'pending_updates' => array(
				'plugins' => isset( $plugin_updates->response ) ? array_keys( (array) $plugin_updates->response ) : array(),
				'themes'  => isset( $theme_updates->response ) ? array_keys( (array) $theme_updates->response ) : array(),
			),
		);
	}

	/* ------------------------------------------------------ plugins & themes */

	private static function load_upgrader() {
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/misc.php';
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		require_once ABSPATH . 'wp-admin/includes/theme.php';
		require_once ABSPATH . 'wp-admin/includes/update.php';
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
	}

	/** Turns the outcome of an upgrader run into true or a WP_Error. */
	private static function upgrader_outcome( $result, $skin, $what ) {
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		if ( is_wp_error( $skin->result ) ) {
			return $skin->result;
		}
		if ( $skin->get_errors()->has_errors() ) {
			return $skin->get_errors();
		}
		if ( ! $result ) {
			return self::error( 'wp_mcp_upgrade_failed', "$what failed. The server may not have direct write access to wp-content.", 500 );
		}
		return true;
	}

	public static function plugin_update( WP_REST_Request $request ) {
		self::load_upgrader();
		$file = (string) $request->get_param( 'plugin' );
		if ( substr( $file, -4 ) !== '.php' ) {
			$file .= '.php';
		}
		if ( ! array_key_exists( $file, get_plugins() ) ) {
			return self::error( 'wp_mcp_not_found', "Plugin $file is not installed.", 404 );
		}
		wp_update_plugins();
		$updates = get_site_transient( 'update_plugins' );
		if ( empty( $updates->response[ $file ] ) ) {
			return array( 'plugin' => $file, 'updated' => false, 'message' => 'Already at the latest available version.' );
		}
		// A single-plugin upgrade deactivates the plugin and leaves it off.
		$was_active  = is_plugin_active( $file );
		$was_network = is_plugin_active_for_network( $file );
		$skin        = new WP_Ajax_Upgrader_Skin();
		$upgrader    = new Plugin_Upgrader( $skin );
		$outcome     = self::upgrader_outcome( $upgrader->upgrade( $file ), $skin, 'Plugin update' );
		if ( $was_active && ! is_plugin_active( $file ) ) {
			activate_plugin( $file, '', $was_network, true );
		}
		if ( is_wp_error( $outcome ) ) {
			return $outcome;
		}
		wp_clean_plugins_cache();
		$data = get_plugins();
		return array( 'plugin' => $file, 'updated' => true, 'version' => $data[ $file ]['Version'], 'active' => is_plugin_active( $file ) );
	}

	public static function theme_install( WP_REST_Request $request ) {
		self::load_upgrader();
		$slug    = (string) $request->get_param( 'slug' );
		$zip_url = (string) $request->get_param( 'zip_url' );
		if ( '' !== $slug ) {
			$api = themes_api( 'theme_information', array( 'slug' => sanitize_key( $slug ), 'fields' => array( 'sections' => false ) ) );
			if ( is_wp_error( $api ) ) {
				return $api;
			}
			$package = $api->download_link;
		} elseif ( wp_http_validate_url( $zip_url ) ) {
			$package = $zip_url;
		} else {
			return self::error( 'wp_mcp_bad_request', 'Provide a WordPress.org theme slug or a valid zip_url.' );
		}
		$skin     = new WP_Ajax_Upgrader_Skin();
		$upgrader = new Theme_Upgrader( $skin );
		$outcome  = self::upgrader_outcome( $upgrader->install( $package ), $skin, 'Theme install' );
		if ( is_wp_error( $outcome ) ) {
			return $outcome;
		}
		$theme = $upgrader->theme_info();
		if ( ! $theme ) {
			return self::error( 'wp_mcp_upgrade_failed', 'The theme was installed but could not be read back.', 500 );
		}
		$activated = false;
		if ( $request->get_param( 'activate' ) ) {
			switch_theme( $theme->get_stylesheet() );
			$activated = true;
		}
		return array( 'stylesheet' => $theme->get_stylesheet(), 'name' => $theme->get( 'Name' ), 'version' => $theme->get( 'Version' ), 'activated' => $activated );
	}

	public static function theme_activate( WP_REST_Request $request ) {
		$theme = wp_get_theme( (string) $request->get_param( 'stylesheet' ) );
		if ( ! $theme->exists() ) {
			return self::error( 'wp_mcp_not_found', 'That theme is not installed.', 404 );
		}
		if ( ! $theme->is_allowed() ) {
			return self::error( 'wp_mcp_not_allowed', 'That theme is not allowed on this site.', 403 );
		}
		$previous = get_stylesheet();
		switch_theme( $theme->get_stylesheet() );
		return array( 'active_theme' => get_stylesheet(), 'previous_theme' => $previous );
	}

	public static function theme_update( WP_REST_Request $request ) {
		self::load_upgrader();
		$stylesheet = (string) $request->get_param( 'stylesheet' );
		if ( ! wp_get_theme( $stylesheet )->exists() ) {
			return self::error( 'wp_mcp_not_found', 'That theme is not installed.', 404 );
		}
		wp_update_themes();
		$updates = get_site_transient( 'update_themes' );
		if ( empty( $updates->response[ $stylesheet ] ) ) {
			return array( 'stylesheet' => $stylesheet, 'updated' => false, 'message' => 'Already at the latest available version.' );
		}
		$skin     = new WP_Ajax_Upgrader_Skin();
		$upgrader = new Theme_Upgrader( $skin );
		$outcome  = self::upgrader_outcome( $upgrader->upgrade( $stylesheet ), $skin, 'Theme update' );
		if ( is_wp_error( $outcome ) ) {
			return $outcome;
		}
		wp_clean_themes_cache();
		return array( 'stylesheet' => $stylesheet, 'updated' => true, 'version' => wp_get_theme( $stylesheet )->get( 'Version' ) );
	}

	public static function theme_delete( WP_REST_Request $request ) {
		self::load_upgrader();
		$stylesheet = (string) $request['stylesheet'];
		if ( ! wp_get_theme( $stylesheet )->exists() ) {
			return self::error( 'wp_mcp_not_found', 'That theme is not installed.', 404 );
		}
		if ( get_stylesheet() === $stylesheet || get_template() === $stylesheet ) {
			return self::error( 'wp_mcp_theme_in_use', 'The active theme (or its parent) cannot be deleted. Activate another theme first.', 409 );
		}
		$result = delete_theme( $stylesheet );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		if ( ! $result ) {
			return self::error( 'wp_mcp_delete_failed', 'The theme could not be deleted. The server may not have direct write access to wp-content.', 500 );
		}
		return array( 'deleted' => true, 'stylesheet' => $stylesheet );
	}

	/* --------------------------------------------------------------- options */

	public static function options_get( WP_REST_Request $request ) {
		$names = array_filter( array_map( 'trim', explode( ',', (string) $request->get_param( 'names' ) ) ) );
		$out   = array();
		foreach ( $names as $name ) {
			// A unique default distinguishes a missing option from a stored false/null.
			$missing      = new stdClass();
			$value        = get_option( $name, $missing );
			$out[ $name ] = $missing === $value ? array( 'exists' => false ) : array( 'exists' => true, 'value' => $value );
		}
		return $out;
	}

	public static function option_set( WP_REST_Request $request ) {
		$name = (string) $request->get_param( 'name' );
		if ( '' === $name ) {
			return self::error( 'wp_mcp_bad_request', 'name is required.' );
		}
		$autoload = $request->get_param( 'autoload' );
		$changed  = update_option( $name, $request->get_param( 'value' ), null === $autoload ? null : (bool) $autoload );
		return array( 'name' => $name, 'changed' => $changed, 'value' => get_option( $name ) );
	}

	public static function option_delete( WP_REST_Request $request ) {
		$name = (string) $request->get_param( 'name' );
		return array( 'name' => $name, 'deleted' => delete_option( $name ) );
	}

	/* ------------------------------------------------------------- post meta */

	private static function require_post( $id ) {
		$post = get_post( (int) $id );
		return $post ? $post : self::error( 'wp_mcp_not_found', "Post $id does not exist.", 404 );
	}

	public static function postmeta_get( WP_REST_Request $request ) {
		$post = self::require_post( $request['id'] );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$key = (string) $request->get_param( 'key' );
		if ( '' !== $key ) {
			$values = get_post_meta( $post->ID, $key, false );
			return array( 'id' => $post->ID, 'key' => $key, 'exists' => ! empty( $values ), 'value' => 1 === count( $values ) ? $values[0] : $values );
		}
		$meta = array();
		foreach ( get_post_meta( $post->ID ) as $meta_key => $values ) {
			$values            = array_map( 'maybe_unserialize', $values );
			$meta[ $meta_key ] = 1 === count( $values ) ? $values[0] : $values;
		}
		return array( 'id' => $post->ID, 'meta' => $meta );
	}

	public static function postmeta_set( WP_REST_Request $request ) {
		$post = self::require_post( $request['id'] );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$key = (string) $request->get_param( 'key' );
		if ( '' === $key ) {
			return self::error( 'wp_mcp_bad_request', 'key is required.' );
		}
		update_post_meta( $post->ID, $key, wp_slash( $request->get_param( 'value' ) ) );
		return array( 'id' => $post->ID, 'key' => $key, 'value' => get_post_meta( $post->ID, $key, true ) );
	}

	public static function postmeta_delete( WP_REST_Request $request ) {
		$post = self::require_post( $request['id'] );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$key = (string) $request->get_param( 'key' );
		if ( '' === $key ) {
			return self::error( 'wp_mcp_bad_request', 'key is required.' );
		}
		return array( 'id' => $post->ID, 'key' => $key, 'deleted' => delete_post_meta( $post->ID, $key ) );
	}

	/* ------------------------------------------------------------- Elementor */

	public static function elementor_get( WP_REST_Request $request ) {
		$post = self::require_post( $request['id'] );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$raw      = get_post_meta( $post->ID, '_elementor_data', true );
		$elements = is_string( $raw ) && '' !== $raw ? json_decode( $raw, true ) : $raw;
		return array(
			'id'               => $post->ID,
			'title'            => $post->post_title,
			'built_with'       => 'builder' === get_post_meta( $post->ID, '_elementor_edit_mode', true ) ? 'elementor' : 'other',
			'template_type'    => get_post_meta( $post->ID, '_elementor_template_type', true ),
			'elementor_active' => defined( 'ELEMENTOR_VERSION' ),
			'page_settings'    => get_post_meta( $post->ID, '_elementor_page_settings', true ),
			'elements'         => is_array( $elements ) ? $elements : array(),
		);
	}

	public static function elementor_set( WP_REST_Request $request ) {
		$post = self::require_post( $request['id'] );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$elements = $request->get_param( 'elements' );
		if ( ! is_array( $elements ) ) {
			return self::error( 'wp_mcp_bad_request', 'elements must be an array (the Elementor element tree).' );
		}
		$settings = $request->get_param( 'page_settings' );
		$document = class_exists( '\Elementor\Plugin' ) ? \Elementor\Plugin::$instance->documents->get( $post->ID, false ) : null;

		if ( $document ) {
			// Saving through the document runs Elementor's own sanitising, revision and CSS handling.
			$data = array( 'elements' => $elements );
			if ( is_array( $settings ) ) {
				$data['settings'] = $settings;
			}
			update_post_meta( $post->ID, '_elementor_edit_mode', 'builder' );
			$saved = $document->save( $data );
			\Elementor\Plugin::$instance->files_manager->clear_cache();
			$via = 'elementor';
		} else {
			update_post_meta( $post->ID, '_elementor_data', wp_slash( wp_json_encode( $elements ) ) );
			update_post_meta( $post->ID, '_elementor_edit_mode', 'builder' );
			if ( is_array( $settings ) ) {
				update_post_meta( $post->ID, '_elementor_page_settings', wp_slash( $settings ) );
			}
			$saved = true;
			$via   = 'post meta (Elementor is not active)';
		}
		return array( 'id' => $post->ID, 'saved' => (bool) $saved, 'saved_via' => $via, 'top_level_elements' => count( $elements ) );
	}

	/* ---------------------------------------------------------- cron & cache */

	public static function cron_list() {
		$events = array();
		foreach ( (array) _get_cron_array() as $timestamp => $hooks ) {
			foreach ( (array) $hooks as $hook => $instances ) {
				foreach ( (array) $instances as $event ) {
					$events[] = array(
						'hook'     => $hook,
						'next_run' => gmdate( 'c', (int) $timestamp ),
						'schedule' => empty( $event['schedule'] ) ? 'once' : $event['schedule'],
						'interval' => isset( $event['interval'] ) ? (int) $event['interval'] : null,
						'args'     => $event['args'],
					);
				}
			}
		}
		return $events;
	}

	public static function cron_run( WP_REST_Request $request ) {
		$hook = (string) $request->get_param( 'hook' );
		$runs = 0;
		foreach ( (array) _get_cron_array() as $hooks ) {
			if ( empty( $hooks[ $hook ] ) ) {
				continue;
			}
			foreach ( $hooks[ $hook ] as $event ) {
				do_action_ref_array( $hook, $event['args'] );
				$runs++;
			}
		}
		if ( 0 === $runs ) {
			return self::error( 'wp_mcp_not_found', "No scheduled event uses the hook $hook.", 404 );
		}
		return array( 'hook' => $hook, 'runs' => $runs );
	}

	public static function cache_flush() {
		$flushed = array();
		wp_cache_flush();
		$flushed[] = 'object cache';
		delete_expired_transients( true );
		$flushed[] = 'expired transients';

		if ( function_exists( 'rocket_clean_domain' ) ) {
			rocket_clean_domain();
			$flushed[] = 'WP Rocket';
		}
		if ( defined( 'LSCWP_V' ) ) {
			do_action( 'litespeed_purge_all' );
			$flushed[] = 'LiteSpeed Cache';
		}
		if ( function_exists( 'w3tc_flush_all' ) ) {
			w3tc_flush_all();
			$flushed[] = 'W3 Total Cache';
		}
		if ( function_exists( 'wp_cache_clear_cache' ) ) {
			wp_cache_clear_cache();
			$flushed[] = 'WP Super Cache';
		}
		if ( function_exists( 'wpfc_clear_all_cache' ) ) {
			wpfc_clear_all_cache( true );
			$flushed[] = 'WP Fastest Cache';
		}
		if ( function_exists( 'sg_cachepress_purge_cache' ) ) {
			sg_cachepress_purge_cache();
			$flushed[] = 'SiteGround Optimizer';
		}
		if ( class_exists( 'autoptimizeCache' ) ) {
			autoptimizeCache::clearall();
			$flushed[] = 'Autoptimize';
		}
		if ( class_exists( '\Elementor\Plugin' ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
			$flushed[] = 'Elementor CSS';
		}
		return array( 'flushed' => $flushed );
	}

	/* ----------------------------------------------------------------- files */

	private static function inside( $path, $base ) {
		$path = wp_normalize_path( $path );
		$base = untrailingslashit( wp_normalize_path( $base ) );
		return $path === $base || 0 === strpos( $path, $base . '/' );
	}

	/**
	 * Resolves a path relative to wp-content and refuses anything that lands
	 * outside it, including through symlinks.
	 */
	private static function resolve_path( $relative, $for_write = false ) {
		$base     = realpath( WP_CONTENT_DIR );
		$relative = trim( str_replace( '\\', '/', (string) $relative ), '/' );
		if ( false !== strpos( $relative, "\0" ) || in_array( '..', explode( '/', $relative ), true ) ) {
			return self::error( 'wp_mcp_bad_path', 'Path must be relative to wp-content and must not contain "..".' );
		}
		$target = '' === $relative ? $base : $base . '/' . $relative;

		if ( $for_write && ! file_exists( $target ) ) {
			// Check the nearest existing ancestor before creating anything.
			$ancestor = dirname( $target );
			while ( ! file_exists( $ancestor ) ) {
				$ancestor = dirname( $ancestor );
			}
			if ( ! self::inside( realpath( $ancestor ), $base ) ) {
				return self::error( 'wp_mcp_bad_path', 'Path is outside wp-content.', 403 );
			}
			return $target;
		}

		$real = realpath( $target );
		if ( false === $real ) {
			return self::error( 'wp_mcp_not_found', "No such file or directory: $relative", 404 );
		}
		if ( ! self::inside( $real, $base ) ) {
			return self::error( 'wp_mcp_bad_path', 'Path is outside wp-content.', 403 );
		}
		return $real;
	}

	public static function file_get( WP_REST_Request $request ) {
		$gate = self::gate( 'WP_MCP_ALLOW_FILES' );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$relative = (string) $request->get_param( 'path' );
		$path     = self::resolve_path( $relative );
		if ( is_wp_error( $path ) ) {
			return $path;
		}

		if ( is_dir( $path ) ) {
			$entries = array();
			foreach ( scandir( $path ) as $name ) {
				if ( '.' === $name || '..' === $name ) {
					continue;
				}
				$full      = $path . '/' . $name;
				$is_dir    = is_dir( $full );
				$entries[] = array(
					'name'     => $name,
					'type'     => $is_dir ? 'dir' : 'file',
					'size'     => $is_dir ? null : filesize( $full ),
					'modified' => gmdate( 'c', (int) filemtime( $full ) ),
				);
			}
			return array( 'path' => $relative, 'type' => 'dir', 'entries' => $entries );
		}
		if ( $request->get_param( 'list' ) ) {
			return self::error( 'wp_mcp_bad_path', 'That path is a file, not a directory.' );
		}

		$size = filesize( $path );
		if ( $size > self::MAX_FILE_BYTES ) {
			return self::error( 'wp_mcp_too_large', "File is $size bytes; the limit is " . self::MAX_FILE_BYTES . '.', 413 );
		}
		$content = file_get_contents( $path );
		$is_text = '' === $content || 1 === preg_match( '//u', $content );
		return array(
			'path'     => $relative,
			'type'     => 'file',
			'size'     => $size,
			'modified' => gmdate( 'c', (int) filemtime( $path ) ),
			'encoding' => $is_text ? 'utf8' : 'base64',
			'content'  => $is_text ? $content : base64_encode( $content ),
		);
	}

	public static function file_write( WP_REST_Request $request ) {
		$gate = self::gate( 'WP_MCP_ALLOW_FILES' );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$relative = (string) $request->get_param( 'path' );
		$path     = self::resolve_path( $relative, true );
		if ( is_wp_error( $path ) ) {
			return $path;
		}
		if ( is_dir( $path ) ) {
			return self::error( 'wp_mcp_bad_path', 'That path is a directory.' );
		}
		$content = (string) $request->get_param( 'content' );
		if ( 'base64' === $request->get_param( 'encoding' ) ) {
			$content = base64_decode( $content, true );
			if ( false === $content ) {
				return self::error( 'wp_mcp_bad_request', 'content is not valid base64.' );
			}
		}
		$existed = file_exists( $path );
		if ( ! wp_mkdir_p( dirname( $path ) ) ) {
			return self::error( 'wp_mcp_write_failed', 'Could not create the parent directory.', 500 );
		}
		$bytes = file_put_contents( $path, $content );
		if ( false === $bytes ) {
			return self::error( 'wp_mcp_write_failed', 'Could not write the file. Check file permissions.', 500 );
		}
		if ( function_exists( 'opcache_invalidate' ) ) {
			@opcache_invalidate( $path, true ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		}
		return array( 'path' => $relative, 'bytes' => $bytes, 'created' => ! $existed );
	}

	/* -------------------------------------------------------------- database */

	public static function db_query( WP_REST_Request $request ) {
		$gate = self::gate( 'WP_MCP_ALLOW_DB' );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		global $wpdb;
		$sql = trim( str_replace( '{prefix}', $wpdb->prefix, (string) $request->get_param( 'sql' ) ) );
		if ( '' === $sql ) {
			return self::error( 'wp_mcp_bad_request', 'sql is required.' );
		}
		$wpdb->hide_errors();

		if ( preg_match( '/^(select|show|describe|desc|explain)\b/i', $sql ) ) {
			$rows = $wpdb->get_results( $sql, ARRAY_A ); // phpcs:ignore WordPress.DB
			if ( $wpdb->last_error ) {
				return self::error( 'wp_mcp_db_error', $wpdb->last_error );
			}
			$count = count( $rows );
			return array(
				'row_count' => $count,
				'truncated' => $count > self::MAX_DB_ROWS,
				'rows'      => array_slice( $rows, 0, self::MAX_DB_ROWS ),
			);
		}

		$affected = $wpdb->query( $sql ); // phpcs:ignore WordPress.DB
		if ( false === $affected ) {
			return self::error( 'wp_mcp_db_error', $wpdb->last_error ? $wpdb->last_error : 'Query failed.' );
		}
		return array( 'affected_rows' => $affected, 'insert_id' => (int) $wpdb->insert_id );
	}

	/* ---------------------------------------------------------------- WP-CLI */

	public static function cli( WP_REST_Request $request ) {
		$gate = self::gate( 'WP_MCP_ALLOW_CLI' );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		if ( ! function_exists( 'proc_open' ) ) {
			return self::error( 'wp_mcp_cli_unavailable', 'This host has disabled proc_open, so WP-CLI cannot be run from PHP.', 501 );
		}
		$args = $request->get_param( 'args' );
		if ( ! is_array( $args ) || empty( $args ) ) {
			return self::error( 'wp_mcp_bad_request', 'args must be a non-empty array of strings.' );
		}
		$args = array_map( 'strval', array_values( $args ) );
		if ( 'shell' === $args[0] ) {
			return self::error( 'wp_mcp_bad_request', 'Interactive commands are not supported.' );
		}

		$binary = defined( 'WP_MCP_CLI_PATH' ) ? WP_MCP_CLI_PATH : 'wp';
		// An argument array is executed directly, with no shell to interpret it.
		$command = array_merge( array( $binary ), $args, array( '--path=' . ABSPATH, '--no-color' ) );
		$process = proc_open( $command, array( 1 => array( 'pipe', 'w' ), 2 => array( 'pipe', 'w' ) ), $pipes, ABSPATH );
		if ( ! is_resource( $process ) ) {
			return self::error( 'wp_mcp_cli_unavailable', "Could not start WP-CLI ($binary). Set WP_MCP_CLI_PATH in wp-config.php to its full path.", 501 );
		}

		stream_set_blocking( $pipes[1], false );
		stream_set_blocking( $pipes[2], false );
		$stdout    = '';
		$stderr    = '';
		$deadline  = time() + self::CLI_TIMEOUT;
		$timed_out = false;
		$exit_code = null;
		while ( true ) {
			$stdout .= stream_get_contents( $pipes[1] );
			$stderr .= stream_get_contents( $pipes[2] );
			$state   = proc_get_status( $process );
			if ( ! $state['running'] ) {
				$exit_code = $state['exitcode'];
				break;
			}
			if ( time() > $deadline ) {
				proc_terminate( $process );
				$timed_out = true;
				break;
			}
			usleep( 50000 );
		}
		$stdout .= stream_get_contents( $pipes[1] );
		$stderr .= stream_get_contents( $pipes[2] );
		fclose( $pipes[1] );
		fclose( $pipes[2] );
		proc_close( $process );

		return array(
			'exit_code' => $exit_code,
			'timed_out' => $timed_out,
			'stdout'    => $stdout,
			'stderr'    => $stderr,
		);
	}
}

WP_MCP_Bridge::init();
