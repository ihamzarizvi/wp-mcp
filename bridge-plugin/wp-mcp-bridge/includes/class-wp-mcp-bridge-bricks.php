<?php
/**
 * Bricks Builder support: page and template element trees, templates, and
 * global classes, variables, colours and theme styles.
 *
 * Bricks keeps a page as a flat array of elements (id, name, parent, children,
 * settings, label) in post meta. The wp-mcp server does the tree editing; this
 * class reads and writes the stored data the way Bricks expects it.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_MCP_Bridge_Bricks {
	const AREAS = array(
		'content' => '_bricks_page_content_2',
		'header'  => '_bricks_page_header_2',
		'footer'  => '_bricks_page_footer_2',
	);

	/** Global data sets and the option each one lives in. */
	const GLOBALS = array(
		'classes'             => 'bricks_global_classes',
		'class_categories'    => 'bricks_global_classes_categories',
		'variables'           => 'bricks_global_variables',
		'variable_categories' => 'bricks_global_variables_categories',
		'colors'              => 'bricks_color_palette',
		'theme_styles'        => 'bricks_theme_styles',
		'components'          => 'bricks_components',
		'pseudo_classes'      => 'bricks_global_pseudo_classes',
		'breakpoints'         => 'bricks_breakpoints',
	);

	const EDITABLE_GLOBALS = array( 'classes', 'variables' );
	const MAX_LIST         = 500;

	public static function register_routes() {
		self::route( '/bricks/templates', 'GET', 'templates_list' );
		self::route( '/bricks/templates', 'POST', 'template_create' );
		self::route( '/bricks/globals', 'GET', 'globals_get' );
		self::route( '/bricks/globals/item', 'POST', 'global_upsert' );
		self::route( '/bricks/globals/item', 'DELETE', 'global_delete' );
		self::route( '/bricks/(?P<id>\d+)', 'GET', 'content_get' );
		self::route( '/bricks/(?P<id>\d+)', 'POST', 'content_set' );
		self::route( '/bricks/(?P<id>\d+)/undo', 'POST', 'content_undo' );
	}

	private static function route( $path, $methods, $callback ) {
		register_rest_route(
			WP_MCP_Bridge::NS,
			$path,
			array(
				'methods'             => $methods,
				'callback'            => array( __CLASS__, $callback ),
				'permission_callback' => array( 'WP_MCP_Bridge', 'can_manage' ),
			)
		);
	}

	private static function error( $code, $message, $status = 400 ) {
		return new WP_Error( $code, $message, array( 'status' => $status ) );
	}

	public static function version() {
		return defined( 'BRICKS_VERSION' ) ? BRICKS_VERSION : null;
	}

	/* -------------------------------------------------------------- content */

	/** Header and footer templates store their elements under their own meta key. */
	private static function resolve_area( $post, $requested ) {
		$requested = (string) $requested;
		if ( '' !== $requested && 'auto' !== $requested ) {
			return isset( self::AREAS[ $requested ] ) ? $requested : self::error( 'wp_mcp_bad_request', 'area must be content, header or footer.' );
		}
		if ( 'bricks_template' === $post->post_type ) {
			$type = (string) get_post_meta( $post->ID, '_bricks_template_type', true );
			if ( 'header' === $type || 'footer' === $type ) {
				return $type;
			}
		}
		return 'content';
	}

	private static function elements( $post_id, $area ) {
		$elements = get_post_meta( $post_id, self::AREAS[ $area ], true );
		return is_array( $elements ) ? array_values( $elements ) : array();
	}

	private static function backup_key( $area ) {
		return '_wp_mcp_bricks_backup_' . $area;
	}

	/** Names of the global classes used by these elements, keyed by class id. */
	private static function class_names( array $elements ) {
		$used = array();
		foreach ( $elements as $element ) {
			if ( ! empty( $element['settings']['_cssGlobalClasses'] ) && is_array( $element['settings']['_cssGlobalClasses'] ) ) {
				foreach ( $element['settings']['_cssGlobalClasses'] as $class_id ) {
					$used[ $class_id ] = true;
				}
			}
		}
		if ( empty( $used ) ) {
			return array();
		}
		$names = array();
		foreach ( (array) get_option( 'bricks_global_classes', array() ) as $class ) {
			if ( isset( $class['id'], $class['name'] ) && isset( $used[ $class['id'] ] ) ) {
				$names[ $class['id'] ] = $class['name'];
			}
		}
		return $names;
	}

	private static function get_post_or_error( $id ) {
		$post = get_post( (int) $id );
		return $post ? $post : self::error( 'wp_mcp_not_found', "Post $id does not exist.", 404 );
	}

	public static function content_get( WP_REST_Request $request ) {
		$post = self::get_post_or_error( $request['id'] );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$area = self::resolve_area( $post, $request->get_param( 'area' ) );
		if ( is_wp_error( $area ) ) {
			return $area;
		}
		$elements = self::elements( $post->ID, $area );
		$backup   = get_post_meta( $post->ID, self::backup_key( $area ), true );
		return array(
			'id'             => $post->ID,
			'title'          => $post->post_title,
			'post_type'      => $post->post_type,
			'status'         => $post->post_status,
			'link'           => get_permalink( $post ),
			'area'           => $area,
			'built_with'     => 'bricks' === get_post_meta( $post->ID, '_bricks_editor_mode', true ) ? 'bricks' : 'other',
			'template_type'  => (string) get_post_meta( $post->ID, '_bricks_template_type', true ),
			'bricks_version' => self::version(),
			'undo_available' => is_array( $backup ) && isset( $backup['saved_at'] ) ? gmdate( 'c', (int) $backup['saved_at'] ) : null,
			'global_classes' => (object) self::class_names( $elements ),
			'elements'       => $elements,
		);
	}

	/** Checks the flat tree is one Bricks can load: unique ids and consistent links. */
	private static function validate( $elements ) {
		if ( ! is_array( $elements ) ) {
			return 'elements must be an array.';
		}
		$ids = array();
		foreach ( $elements as $element ) {
			if ( ! is_array( $element ) || empty( $element['id'] ) || ! is_string( $element['id'] ) || empty( $element['name'] ) || ! is_string( $element['name'] ) ) {
				return 'Every element needs a string id and a string name.';
			}
			if ( isset( $ids[ $element['id'] ] ) ) {
				return 'Duplicate element id ' . $element['id'] . '.';
			}
			$ids[ $element['id'] ] = true;
		}
		foreach ( $elements as $element ) {
			$parent = isset( $element['parent'] ) ? $element['parent'] : 0;
			if ( ! empty( $parent ) && ! isset( $ids[ (string) $parent ] ) ) {
				return 'Element ' . $element['id'] . ' has a parent that does not exist.';
			}
			foreach ( isset( $element['children'] ) ? (array) $element['children'] : array() as $child ) {
				if ( ! isset( $ids[ (string) $child ] ) ) {
					return 'Element ' . $element['id'] . ' lists a child that does not exist.';
				}
			}
		}
		return true;
	}

	/** Bricks expects parent 0 for root elements, and always a children array and a settings map. */
	private static function normalise( array $elements ) {
		$out = array();
		foreach ( $elements as $element ) {
			$element['parent']   = empty( $element['parent'] ) ? 0 : (string) $element['parent'];
			$element['children'] = isset( $element['children'] ) && is_array( $element['children'] ) ? array_values( array_map( 'strval', $element['children'] ) ) : array();
			$element['settings'] = isset( $element['settings'] ) && is_array( $element['settings'] ) ? $element['settings'] : array();
			$out[]               = $element;
		}
		return $out;
	}

	private static function write( $post, $area, array $elements ) {
		$key = self::AREAS[ $area ];
		if ( empty( $elements ) ) {
			delete_post_meta( $post->ID, $key );
		} else {
			update_post_meta( $post->ID, $key, wp_slash( $elements ) );
		}
		update_post_meta( $post->ID, '_bricks_editor_mode', 'bricks' );
		clean_post_cache( $post->ID );
		return self::regenerate_css( $post->ID, $area, $elements );
	}

	/** Only sites that load Bricks CSS from files need a file rebuilt after a change. */
	private static function regenerate_css( $post_id, $area, array $elements ) {
		if ( ! class_exists( '\Bricks\Database' ) || 'file' !== \Bricks\Database::get_setting( 'cssLoading' ) ) {
			return 'not needed (inline CSS)';
		}
		if ( ! is_callable( array( '\Bricks\Assets_Files', 'generate_post_css_file' ) ) ) {
			return 'skipped: regenerate CSS files under Bricks > Settings > Performance';
		}
		try {
			\Bricks\Assets_Files::generate_post_css_file( $post_id, $area, $elements );
			return 'regenerated';
		} catch ( \Throwable $e ) {
			return 'failed (' . $e->getMessage() . '): regenerate CSS files under Bricks > Settings > Performance';
		}
	}

	public static function content_set( WP_REST_Request $request ) {
		$post = self::get_post_or_error( $request['id'] );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$area = self::resolve_area( $post, $request->get_param( 'area' ) );
		if ( is_wp_error( $area ) ) {
			return $area;
		}
		$elements = $request->get_param( 'elements' );
		$valid    = self::validate( $elements );
		if ( true !== $valid ) {
			return self::error( 'wp_mcp_bad_request', $valid );
		}
		$previous = self::elements( $post->ID, $area );
		update_post_meta( $post->ID, self::backup_key( $area ), wp_slash( array( 'saved_at' => time(), 'elements' => $previous ) ) );
		$elements = self::normalise( $elements );
		$css      = self::write( $post, $area, $elements );
		return array(
			'id'               => $post->ID,
			'area'             => $area,
			'saved'            => true,
			'elements'         => count( $elements ),
			'previous_elements' => count( $previous ),
			'css'              => $css,
			'link'             => get_permalink( $post ),
		);
	}

	/** Swaps the current elements with the copy taken before the last save. */
	public static function content_undo( WP_REST_Request $request ) {
		$post = self::get_post_or_error( $request['id'] );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$area = self::resolve_area( $post, $request->get_param( 'area' ) );
		if ( is_wp_error( $area ) ) {
			return $area;
		}
		$backup = get_post_meta( $post->ID, self::backup_key( $area ), true );
		if ( ! is_array( $backup ) || ! isset( $backup['elements'] ) || ! is_array( $backup['elements'] ) ) {
			return self::error( 'wp_mcp_not_found', 'There is no earlier version to restore for this page.', 404 );
		}
		$current = self::elements( $post->ID, $area );
		update_post_meta( $post->ID, self::backup_key( $area ), wp_slash( array( 'saved_at' => time(), 'elements' => $current ) ) );
		$css = self::write( $post, $area, array_values( $backup['elements'] ) );
		return array(
			'id'             => $post->ID,
			'area'           => $area,
			'restored'       => true,
			'elements'       => count( $backup['elements'] ),
			'replaced'       => count( $current ),
			'version_from'   => gmdate( 'c', (int) $backup['saved_at'] ),
			'css'            => $css,
		);
	}

	/* ------------------------------------------------------------ templates */

	public static function templates_list( WP_REST_Request $request ) {
		$type  = (string) $request->get_param( 'type' );
		$posts = get_posts(
			array(
				'post_type'   => 'bricks_template',
				'post_status' => 'any',
				'numberposts' => 200,
				'orderby'     => 'modified',
				'order'       => 'DESC',
			)
		);
		$out = array();
		foreach ( $posts as $post ) {
			$template_type = (string) get_post_meta( $post->ID, '_bricks_template_type', true );
			if ( '' !== $type && $type !== $template_type ) {
				continue;
			}
			$settings = get_post_meta( $post->ID, '_bricks_template_settings', true );
			$area     = 'header' === $template_type || 'footer' === $template_type ? $template_type : 'content';
			$out[]    = array(
				'id'         => $post->ID,
				'title'      => $post->post_title,
				'type'       => $template_type,
				'status'     => $post->post_status,
				'modified'   => get_post_modified_time( 'c', true, $post ),
				'elements'   => count( self::elements( $post->ID, $area ) ),
				'conditions' => is_array( $settings ) && isset( $settings['templateConditions'] ) ? $settings['templateConditions'] : array(),
			);
		}
		return $out;
	}

	public static function template_create( WP_REST_Request $request ) {
		if ( ! post_type_exists( 'bricks_template' ) ) {
			return self::error( 'wp_mcp_bricks_inactive', 'Bricks is not the active theme on this site, so templates cannot be created.', 409 );
		}
		$title = sanitize_text_field( (string) $request->get_param( 'title' ) );
		$type  = sanitize_key( (string) $request->get_param( 'type' ) );
		if ( '' === $title || '' === $type ) {
			return self::error( 'wp_mcp_bad_request', 'title and type are required.' );
		}
		$status = 'publish' === $request->get_param( 'status' ) ? 'publish' : 'draft';
		$id     = wp_insert_post( array( 'post_type' => 'bricks_template', 'post_title' => $title, 'post_status' => $status ), true );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		update_post_meta( $id, '_bricks_template_type', $type );
		update_post_meta( $id, '_bricks_editor_mode', 'bricks' );
		$conditions = $request->get_param( 'conditions' );
		if ( is_array( $conditions ) && ! empty( $conditions ) ) {
			update_post_meta( $id, '_bricks_template_settings', wp_slash( array( 'templateConditions' => array_values( $conditions ) ) ) );
		}
		return array( 'id' => $id, 'title' => $title, 'type' => $type, 'status' => $status );
	}

	/* -------------------------------------------------------------- globals */

	private static function global_option( $what ) {
		return isset( self::GLOBALS[ $what ] ) ? self::GLOBALS[ $what ] : self::error( 'wp_mcp_bad_request', 'what must be one of: ' . implode( ', ', array_keys( self::GLOBALS ) ) . '.' );
	}

	/** Short form of one item, so large sets can be listed without their full settings. */
	private static function summarise( $what, $key, $item ) {
		if ( ! is_array( $item ) ) {
			return $item;
		}
		if ( 'classes' === $what ) {
			return array(
				'id'       => isset( $item['id'] ) ? $item['id'] : $key,
				'name'     => isset( $item['name'] ) ? $item['name'] : '',
				'category' => isset( $item['category'] ) ? $item['category'] : '',
				'sets'     => isset( $item['settings'] ) && is_array( $item['settings'] ) ? array_keys( $item['settings'] ) : array(),
			);
		}
		if ( 'colors' === $what ) {
			$colors = array();
			foreach ( isset( $item['colors'] ) ? (array) $item['colors'] : array() as $color ) {
				$value = '';
				foreach ( array( 'raw', 'hex', 'rgb', 'hsl' ) as $format ) {
					if ( ! empty( $color[ $format ] ) ) {
						$value = $color[ $format ];
						break;
					}
				}
				$colors[] = array( 'id' => isset( $color['id'] ) ? $color['id'] : '', 'name' => isset( $color['name'] ) ? $color['name'] : '', 'value' => $value );
			}
			return array( 'id' => isset( $item['id'] ) ? $item['id'] : $key, 'name' => isset( $item['name'] ) ? $item['name'] : '', 'colors' => $colors );
		}
		if ( 'theme_styles' === $what ) {
			return array(
				'id'         => $key,
				'label'      => isset( $item['label'] ) ? $item['label'] : '',
				'groups'     => isset( $item['settings'] ) && is_array( $item['settings'] ) ? array_keys( $item['settings'] ) : array(),
			);
		}
		if ( 'components' === $what ) {
			return array( 'id' => isset( $item['id'] ) ? $item['id'] : $key, 'label' => isset( $item['label'] ) ? $item['label'] : '', 'category' => isset( $item['category'] ) ? $item['category'] : '' );
		}
		return $item;
	}

	public static function globals_get( WP_REST_Request $request ) {
		$what   = (string) $request->get_param( 'what' );
		$option = self::global_option( $what );
		if ( is_wp_error( $option ) ) {
			return $option;
		}
		$data   = get_option( $option, array() );
		$data   = is_array( $data ) ? $data : array();
		$id     = (string) $request->get_param( 'id' );
		$search = strtolower( (string) $request->get_param( 'search' ) );
		$full   = (bool) $request->get_param( 'full' ) || '' !== $id;
		$items  = array();
		$total  = 0;

		foreach ( $data as $key => $item ) {
			$item_id = is_array( $item ) && isset( $item['id'] ) ? (string) $item['id'] : (string) $key;
			if ( '' !== $id && $item_id !== $id ) {
				continue;
			}
			if ( '' !== $search ) {
				$haystack = is_array( $item ) ? strtolower( $item_id . ' ' . ( isset( $item['name'] ) ? $item['name'] : '' ) . ' ' . ( isset( $item['label'] ) ? $item['label'] : '' ) . ' ' . ( isset( $item['category'] ) ? $item['category'] : '' ) ) : strtolower( (string) $item );
				if ( false === strpos( $haystack, $search ) ) {
					continue;
				}
			}
			$total++;
			if ( count( $items ) < self::MAX_LIST ) {
				$items[] = $full ? ( 'theme_styles' === $what && is_array( $item ) ? array_merge( array( 'id' => $key ), $item ) : $item ) : self::summarise( $what, $key, $item );
			}
		}
		return array( 'what' => $what, 'total' => $total, 'returned' => count( $items ), 'full' => $full, 'items' => $items );
	}

	private static function random_id() {
		return strtolower( wp_generate_password( 6, false ) );
	}

	/** Lets an open Bricks builder notice that the global classes changed underneath it. */
	private static function touch_classes( $what ) {
		if ( 'classes' === $what ) {
			update_option( 'bricks_global_classes_timestamp', time() );
			update_option( 'bricks_global_classes_user', get_current_user_id() );
		}
	}

	public static function global_upsert( WP_REST_Request $request ) {
		$what = (string) $request->get_param( 'what' );
		if ( ! in_array( $what, self::EDITABLE_GLOBALS, true ) ) {
			return self::error( 'wp_mcp_bad_request', 'Only classes and variables can be changed with this tool.' );
		}
		$item = $request->get_param( 'item' );
		if ( ! is_array( $item ) || empty( $item['name'] ) || ! is_string( $item['name'] ) ) {
			return self::error( 'wp_mcp_bad_request', 'item must be an object with at least a name.' );
		}
		$option = self::GLOBALS[ $what ];
		$data   = get_option( $option, array() );
		$data   = is_array( $data ) ? array_values( $data ) : array();
		$index  = null;
		foreach ( $data as $i => $existing ) {
			$same_id   = ! empty( $item['id'] ) && isset( $existing['id'] ) && (string) $existing['id'] === (string) $item['id'];
			$same_name = empty( $item['id'] ) && isset( $existing['name'] ) && $existing['name'] === $item['name'];
			if ( $same_id || $same_name ) {
				$index = $i;
				break;
			}
		}
		if ( null === $index ) {
			if ( empty( $item['id'] ) ) {
				$item['id'] = self::random_id();
			}
			if ( 'classes' === $what && ! isset( $item['settings'] ) ) {
				$item['settings'] = array();
			}
			$data[]  = $item;
			$created = true;
			$saved   = $item;
		} else {
			// Fields that are not sent keep their current value.
			$saved          = array_merge( $data[ $index ], $item );
			$data[ $index ] = $saved;
			$created        = false;
		}
		update_option( $option, $data );
		self::touch_classes( $what );
		return array( 'what' => $what, 'created' => $created, 'item' => $saved );
	}

	public static function global_delete( WP_REST_Request $request ) {
		$what = (string) $request->get_param( 'what' );
		if ( ! in_array( $what, self::EDITABLE_GLOBALS, true ) ) {
			return self::error( 'wp_mcp_bad_request', 'Only classes and variables can be deleted with this tool.' );
		}
		$id     = (string) $request->get_param( 'id' );
		$option = self::GLOBALS[ $what ];
		$data   = get_option( $option, array() );
		$data   = is_array( $data ) ? array_values( $data ) : array();
		$kept   = array();
		$gone   = null;
		foreach ( $data as $existing ) {
			if ( null === $gone && isset( $existing['id'] ) && (string) $existing['id'] === $id ) {
				$gone = $existing;
				continue;
			}
			$kept[] = $existing;
		}
		if ( null === $gone ) {
			return self::error( 'wp_mcp_not_found', "No item with id $id in $what.", 404 );
		}
		update_option( $option, $kept );
		self::touch_classes( $what );
		return array( 'what' => $what, 'deleted' => true, 'item' => $gone );
	}
}
